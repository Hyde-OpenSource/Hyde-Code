//! Deterministic, dependency-free command matching and planning for Hyde AI.
//!
//! The core intentionally knows nothing about TOML, audio, or an operating-system
//! shell. `hyde-pack` compiles data files into the types in this crate; this crate
//! then performs bounded string matching and produces validated tasks.

use std::collections::BTreeMap;
use std::fmt;
use std::process::Command;

const PACK_MAGIC: &[u8; 8] = b"HYDEPK01";
const PACK_VERSION: u16 = 1;

#[derive(Clone, Debug, PartialEq, Eq)]
pub enum Risk {
    L0,
    L1,
    L2,
    L3,
}

impl Risk {
    pub fn as_str(&self) -> &'static str {
        match self {
            Self::L0 => "L0",
            Self::L1 => "L1",
            Self::L2 => "L2",
            Self::L3 => "L3",
        }
    }

    #[allow(clippy::should_implement_trait)]
    pub fn from_str(value: &str) -> Result<Self, PackError> {
        match value.to_ascii_uppercase().as_str() {
            "L0" => Ok(Self::L0),
            "L1" => Ok(Self::L1),
            "L2" => Ok(Self::L2),
            "L3" => Ok(Self::L3),
            other => Err(PackError(format!("invalid risk level: {other}"))),
        }
    }
}

#[derive(Clone, Debug, PartialEq, Eq)]
pub enum SlotKind {
    Single,
    OneOrMore,
    Rest,
    Enum(Vec<String>),
}

#[derive(Clone, Debug, PartialEq, Eq)]
pub enum PatternToken {
    Literal(String),
    Slot { name: String, kind: SlotKind },
    Optional(Box<PatternToken>),
}

#[derive(Clone, Debug, PartialEq, Eq)]
pub struct IntentDefinition {
    pub id: String,
    pub risk: Risk,
    pub parallel: bool,
    pub action: String,
    pub response: Option<String>,
    pub triggers: Vec<String>,
    pub patterns: Vec<Vec<PatternToken>>,
}

#[derive(Clone, Debug, PartialEq, Eq)]
pub struct AppEntry {
    pub id: String,
    pub name: String,
    pub aliases: Vec<String>,
    /// Executable name or absolute path. It is never passed through a shell.
    pub command: String,
}

impl AppEntry {
    fn phrases(&self) -> impl Iterator<Item = &str> {
        std::iter::once(self.name.as_str()).chain(self.aliases.iter().map(String::as_str))
    }
}

#[derive(Clone, Debug, PartialEq, Eq, Default)]
pub struct Pack {
    pub intents: Vec<IntentDefinition>,
    pub apps: Vec<AppEntry>,
    pub vocabulary: Vec<String>,
}

#[derive(Clone, Debug, PartialEq, Eq)]
pub struct PackError(pub String);

impl fmt::Display for PackError {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        f.write_str(&self.0)
    }
}

impl std::error::Error for PackError {}

impl Pack {
    pub fn to_bytes(&self) -> Result<Vec<u8>, PackError> {
        let mut w = Writer::default();
        w.bytes(PACK_MAGIC);
        w.u16(PACK_VERSION);
        w.u32(self.intents.len())?;
        for intent in &self.intents {
            w.string(&intent.id)?;
            w.u8(match intent.risk {
                Risk::L0 => 0,
                Risk::L1 => 1,
                Risk::L2 => 2,
                Risk::L3 => 3,
            });
            w.u8(u8::from(intent.parallel));
            w.string(&intent.action)?;
            w.optional_string(intent.response.as_deref())?;
            write_strings(&mut w, &intent.triggers)?;
            w.u32(intent.patterns.len())?;
            for pattern in &intent.patterns {
                w.u32(pattern.len())?;
                for token in pattern {
                    write_pattern_token(&mut w, token)?;
                }
            }
        }
        w.u32(self.apps.len())?;
        for app in &self.apps {
            w.string(&app.id)?;
            w.string(&app.name)?;
            write_strings(&mut w, &app.aliases)?;
            w.string(&app.command)?;
        }
        write_strings(&mut w, &self.vocabulary)?;
        Ok(w.into_inner())
    }

    pub fn from_bytes(bytes: &[u8]) -> Result<Self, PackError> {
        let mut r = Reader::new(bytes);
        if r.take(8)? != PACK_MAGIC.as_slice() {
            return Err(PackError("invalid Hyde pack magic".into()));
        }
        if r.u16()? != PACK_VERSION {
            return Err(PackError("unsupported Hyde pack version".into()));
        }
        let intent_count = r.count("intent")?;
        let mut intents = Vec::with_capacity(intent_count);
        for _ in 0..intent_count {
            let id = r.string()?;
            let risk = match r.u8()? {
                0 => Risk::L0,
                1 => Risk::L1,
                2 => Risk::L2,
                3 => Risk::L3,
                _ => return Err(PackError("invalid packed risk level".into())),
            };
            let parallel = r.u8()? != 0;
            let action = r.string()?;
            let response = r.optional_string()?;
            let triggers = r.strings()?;
            let pattern_count = r.count("pattern")?;
            let mut patterns = Vec::with_capacity(pattern_count);
            for _ in 0..pattern_count {
                let token_count = r.count("pattern token")?;
                let mut pattern = Vec::with_capacity(token_count);
                for _ in 0..token_count {
                    pattern.push(read_pattern_token(&mut r)?);
                }
                patterns.push(pattern);
            }
            intents.push(IntentDefinition {
                id,
                risk,
                parallel,
                action,
                response,
                triggers,
                patterns,
            });
        }
        let app_count = r.count("app")?;
        let mut apps = Vec::with_capacity(app_count);
        for _ in 0..app_count {
            apps.push(AppEntry {
                id: r.string()?,
                name: r.string()?,
                aliases: r.strings()?,
                command: r.string()?,
            });
        }
        let vocabulary = r.strings()?;
        if !r.is_empty() {
            return Err(PackError("trailing bytes in Hyde pack".into()));
        }
        Ok(Self {
            intents,
            apps,
            vocabulary,
        })
    }
}

#[derive(Clone, Debug, PartialEq, Eq)]
pub enum SlotValue {
    App(AppEntry),
    Number(i64),
    Text(String),
    Enum(String),
    Context(String),
}

impl SlotValue {
    pub fn as_text(&self) -> String {
        match self {
            Self::App(app) => app.name.clone(),
            Self::Number(n) => n.to_string(),
            Self::Text(value) | Self::Enum(value) | Self::Context(value) => value.clone(),
        }
    }
}

#[derive(Clone, Debug, PartialEq, Eq)]
pub struct SlotAssignment {
    pub name: String,
    pub value: SlotValue,
}

#[derive(Clone, Debug, PartialEq, Eq)]
pub struct Task {
    pub id: u32,
    pub action: String,
    pub args: Vec<SlotAssignment>,
    pub depends_on: Vec<u32>,
    pub risk: Risk,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Decision {
    Execute,
    Confirm,
    Reject,
}

#[derive(Clone, Debug, PartialEq)]
pub struct Plan {
    pub decision: Decision,
    pub score: f32,
    pub intent_ids: Vec<String>,
    pub tasks: Vec<Task>,
    pub response: Option<String>,
    pub explanation: String,
}

#[derive(Clone, Debug, Default, PartialEq, Eq)]
pub struct Context {
    pub last_app: Option<AppEntry>,
}

#[derive(Clone, Debug)]
struct Candidate {
    intent: IntentDefinition,
    slots: Vec<SlotAssignment>,
    score: f32,
    literals: usize,
    missing: bool,
}

#[derive(Clone, Debug)]
struct PatternMatch {
    slots: Vec<SlotAssignment>,
    literal_matches: usize,
    slot_count: usize,
    valid_slots: usize,
    missing: bool,
    failed: bool,
    consumed: usize,
}

pub struct Matcher<'a> {
    pack: &'a Pack,
    usage: BTreeMap<String, u32>,
}

impl<'a> Matcher<'a> {
    pub fn new(pack: &'a Pack) -> Self {
        Self {
            pack,
            usage: BTreeMap::new(),
        }
    }

    pub fn with_usage(pack: &'a Pack, usage: BTreeMap<String, u32>) -> Self {
        Self { pack, usage }
    }

    pub fn match_text(&self, input: &str, context: &Context) -> Plan {
        let normalized = normalize(input);
        if normalized.is_empty() {
            return rejected("empty command");
        }
        let stages = split_sequence(&normalized);
        let mut all_tasks = Vec::new();
        let mut intent_ids = Vec::new();
        let mut responses = Vec::new();
        let mut previous_stage_ids = Vec::new();
        let mut lowest_score = 1.0_f32;
        let mut next_id = 1_u32;

        for stage in stages {
            let clauses = split_parallel(&stage);
            let mut stage_tasks = Vec::new();
            let mut stage_match: Option<Candidate> = None;
            for clause in clauses {
                let candidate = self.best_candidate(&clause, context);
                if let Some(candidate) = candidate {
                    lowest_score = lowest_score.min(candidate.score);
                    if stage_match.is_none() {
                        stage_match = Some(candidate.clone());
                    }
                    let task_count_before = stage_tasks.len();
                    for assignment in expand_app_list(candidate.slots.clone()) {
                        stage_tasks.push(Task {
                            id: next_id,
                            action: candidate.intent.action.clone(),
                            args: assignment,
                            depends_on: Vec::new(),
                            risk: candidate.intent.risk.clone(),
                        });
                        next_id += 1;
                    }
                    if task_count_before == stage_tasks.len() {
                        stage_tasks.push(Task {
                            id: next_id,
                            action: candidate.intent.action.clone(),
                            args: candidate.slots,
                            depends_on: Vec::new(),
                            risk: candidate.intent.risk,
                        });
                        next_id += 1;
                    }
                    intent_ids.push(candidate.intent.id);
                    if let Some(response) = candidate.intent.response {
                        responses.push(response);
                    }
                } else {
                    return rejected(&format!("no intent matched clause: {clause}"));
                }
            }
            if let Some(candidate) = stage_match {
                if candidate.missing {
                    return Plan {
                        decision: if candidate.score >= 0.55 {
                            Decision::Confirm
                        } else {
                            Decision::Reject
                        },
                        score: candidate.score,
                        intent_ids,
                        tasks: Vec::new(),
                        response: candidate.intent.response,
                        explanation: "required slot is missing".into(),
                    };
                }
            }
            for task in &mut stage_tasks {
                task.depends_on.extend(previous_stage_ids.iter().copied());
            }
            previous_stage_ids = stage_tasks.iter().map(|task| task.id).collect();
            all_tasks.extend(stage_tasks);
        }

        let mut decision = if lowest_score >= 0.80 {
            Decision::Execute
        } else if lowest_score >= 0.55 {
            Decision::Confirm
        } else {
            Decision::Reject
        };
        // L2 and L3 tasks change the system (installs, power, deletes): never run them unasked.
        if decision == Decision::Execute
            && all_tasks
                .iter()
                .any(|task| matches!(task.risk, Risk::L2 | Risk::L3))
        {
            decision = Decision::Confirm;
        }
        Plan {
            decision,
            score: lowest_score,
            intent_ids,
            tasks: all_tasks,
            response: responses.into_iter().next(),
            explanation: match decision {
                Decision::Execute => "matched deterministically".into(),
                Decision::Confirm if lowest_score >= 0.80 => {
                    "this action needs your confirmation".into()
                }
                Decision::Confirm => "match is below the execution threshold".into(),
                Decision::Reject => "match is below the confirmation threshold".into(),
            },
        }
    }

    fn best_candidate(&self, clause: &str, context: &Context) -> Option<Candidate> {
        let tokens: Vec<&str> = clause.split_whitespace().collect();
        let mut best: Option<Candidate> = None;
        for intent in &self.pack.intents {
            // Trigger lookup is intentionally simple in M1. The compiled vocabulary still
            // makes this bounded; an Aho-Corasick index can replace this without changing API.
            let trigger_hit = intent.triggers.is_empty()
                || intent.triggers.iter().any(|trigger| {
                    let normalized_trigger = normalize(trigger);
                    let trigger_tokens: Vec<&str> = normalized_trigger.split_whitespace().collect();
                    contains_tokens(&tokens, &trigger_tokens)
                });
            if !trigger_hit {
                continue;
            }
            for pattern in &intent.patterns {
                if let Some(matched) =
                    match_pattern(pattern, &tokens, &self.pack.apps, &intent.triggers, context)
                {
                    let coverage = if tokens.is_empty() {
                        0.0
                    } else {
                        matched.consumed.min(tokens.len()) as f32 / tokens.len() as f32
                    };
                    let slot_confidence = if matched.slot_count == 0 {
                        1.0
                    } else {
                        (matched.valid_slots as f32 / matched.slot_count as f32).min(1.0)
                    };
                    let prior = self
                        .usage
                        .get(&intent.id)
                        .map(|count| (0.5 + (*count as f32 / 10.0)).min(1.0))
                        .unwrap_or(0.5);
                    let score = 0.5 * coverage + 0.3 * slot_confidence + 0.2 * prior;
                    let candidate = Candidate {
                        intent: intent.clone(),
                        slots: matched.slots,
                        score,
                        literals: matched.literal_matches,
                        missing: matched.missing,
                    };
                    let better = best.as_ref().is_none_or(|current| {
                        candidate.score > current.score + f32::EPSILON
                            || ((candidate.score - current.score).abs() <= f32::EPSILON
                                && candidate.literals > current.literals)
                    });
                    if better {
                        best = Some(candidate);
                    }
                }
            }
        }
        best
    }
}

fn rejected(explanation: &str) -> Plan {
    Plan {
        decision: Decision::Reject,
        score: 0.0,
        intent_ids: Vec::new(),
        tasks: Vec::new(),
        response: None,
        explanation: explanation.into(),
    }
}

pub fn normalize(input: &str) -> String {
    let mut words = Vec::new();
    let mut current = String::new();
    for ch in input.chars().flat_map(char::to_lowercase) {
        if ch.is_alphanumeric() || ch == '_' {
            current.push(ch);
        } else if !current.is_empty() {
            words.push(std::mem::take(&mut current));
        }
    }
    if !current.is_empty() {
        words.push(current);
    }
    let fillers = ["please", "can", "you", "could", "would", "kindly"];
    words.retain(|word| !fillers.contains(&word.as_str()));
    let mut normalized = Vec::with_capacity(words.len());
    let mut i = 0;
    while i < words.len() {
        if let Some((value, consumed)) = parse_number_words(&words[i..]) {
            normalized.push(value.to_string());
            i += consumed;
        } else {
            normalized.push(words[i].clone());
            i += 1;
        }
    }
    normalized.join(" ")
}

fn parse_number_words(words: &[String]) -> Option<(i64, usize)> {
    let first = number_word(&words[0])?;
    if words.len() > 1 {
        if let Some(second) = number_word(&words[1]) {
            if first >= 20 && first % 10 == 0 && second < 10 {
                return Some((first + second, 2));
            }
        }
    }
    Some((first, 1))
}

fn number_word(word: &str) -> Option<i64> {
    Some(match word {
        "zero" => 0,
        "one" => 1,
        "two" => 2,
        "three" => 3,
        "four" => 4,
        "five" => 5,
        "six" => 6,
        "seven" => 7,
        "eight" => 8,
        "nine" => 9,
        "ten" => 10,
        "eleven" => 11,
        "twelve" => 12,
        "thirteen" => 13,
        "fourteen" => 14,
        "fifteen" => 15,
        "sixteen" => 16,
        "seventeen" => 17,
        "eighteen" => 18,
        "nineteen" => 19,
        "twenty" => 20,
        "thirty" => 30,
        "forty" => 40,
        "fifty" => 50,
        "sixty" => 60,
        "seventy" => 70,
        "eighty" => 80,
        "ninety" => 90,
        _ => return None,
    })
}

fn split_sequence(input: &str) -> Vec<String> {
    let tokens: Vec<&str> = input.split_whitespace().collect();
    let mut result = Vec::new();
    let mut current = Vec::new();
    let mut i = 0;
    while i < tokens.len() {
        let is_boundary = tokens[i] == "then"
            || (tokens[i] == "after" && tokens.get(i + 1) == Some(&"that"))
            || (tokens[i] == "once" && tokens.get(i + 1) == Some(&"done"));
        if is_boundary {
            if !current.is_empty() {
                result.push(current.join(" "));
                current.clear();
            }
            i += if tokens[i] == "then" { 1 } else { 2 };
        } else {
            current.push(tokens[i]);
            i += 1;
        }
    }
    if !current.is_empty() {
        result.push(current.join(" "));
    }
    result
}

fn split_parallel(input: &str) -> Vec<String> {
    // Commas are normalized to spaces, so the textual connectors are the portable form.
    let tokens: Vec<&str> = input.split_whitespace().collect();
    let mut clauses = Vec::new();
    let mut current = Vec::new();
    for token in tokens {
        if matches!(token, "also" | "plus") {
            if !current.is_empty() {
                clauses.push(current.join(" "));
                current.clear();
            }
        } else {
            current.push(token);
        }
    }
    // `and` is kept inside a clause because `{app+}` consumes it as a list separator.
    if !current.is_empty() {
        clauses.push(current.join(" "));
    }
    clauses
}

fn contains_tokens(haystack: &[&str], needle: &[&str]) -> bool {
    needle.len() <= haystack.len()
        && haystack
            .windows(needle.len())
            .any(|window| window == needle)
}

struct MatchEnv<'a> {
    apps: &'a [AppEntry],
    triggers: &'a [String],
    context: &'a Context,
}

fn match_pattern(
    pattern: &[PatternToken],
    tokens: &[&str],
    apps: &[AppEntry],
    triggers: &[String],
    context: &Context,
) -> Option<PatternMatch> {
    let mut result = PatternMatch {
        slots: Vec::new(),
        literal_matches: 0,
        slot_count: 0,
        valid_slots: 0,
        missing: false,
        failed: false,
        consumed: 0,
    };
    let env = MatchEnv {
        apps,
        triggers,
        context,
    };
    let mut position = 0;
    for token in pattern {
        match_pattern_token(token, tokens, &mut position, &env, &mut result, false);
        if result.failed {
            return None;
        }
    }
    if result.literal_matches == 0 && result.valid_slots == 0 {
        return None;
    }
    Some(result)
}

fn match_pattern_token(
    token: &PatternToken,
    tokens: &[&str],
    position: &mut usize,
    env: &MatchEnv<'_>,
    result: &mut PatternMatch,
    optional: bool,
) {
    let apps = env.apps;
    let context = env.context;
    match token {
        PatternToken::Literal(literal) => {
            if tokens.get(*position) == Some(&literal.as_str()) {
                result.literal_matches += 1;
                *position += 1;
            } else if !optional {
                // A required literal that is absent means this pattern does not apply.
                result.failed = true;
            }
        }
        PatternToken::Optional(inner) => {
            match_pattern_token(inner, tokens, position, env, result, true);
        }
        PatternToken::Slot {
            name,
            kind: SlotKind::Single,
        } if name == "trigger" => {
            // `{trigger}` only accepts one of the intent's own trigger phrases.
            result.slot_count += 1;
            let rest = &tokens[(*position).min(tokens.len())..];
            let hit = env
                .triggers
                .iter()
                .map(|trigger| trigger.split_whitespace().collect::<Vec<_>>())
                .filter(|words| {
                    !words.is_empty()
                        && words.len() <= rest.len()
                        && rest[..words.len()] == words[..]
                })
                .max_by_key(Vec::len);
            match hit {
                Some(words) => {
                    result.valid_slots += 1;
                    result.literal_matches += 1;
                    result.slots.push(SlotAssignment {
                        name: name.clone(),
                        value: SlotValue::Text(words.join(" ")),
                    });
                    *position += words.len();
                }
                None if optional => {}
                None => result.failed = true,
            }
        }
        PatternToken::Slot { name, kind } => {
            result.slot_count += 1;
            match kind {
                SlotKind::Rest => {
                    if *position < tokens.len() {
                        result.valid_slots += 1;
                        result.slots.push(SlotAssignment {
                            name: name.clone(),
                            value: SlotValue::Text(tokens[*position..].join(" ")),
                        });
                        *position = tokens.len();
                    } else if !optional {
                        result.missing = true;
                    }
                }
                SlotKind::OneOrMore => {
                    let values = resolve_app_list(tokens.get(*position..).unwrap_or(&[]), apps);
                    if values.is_empty() {
                        if !optional {
                            result.missing = true;
                        }
                    } else {
                        result.valid_slots += values.len();
                        for value in values {
                            result.slots.push(SlotAssignment {
                                name: name.clone(),
                                value,
                            });
                        }
                        *position = tokens.len();
                    }
                }
                SlotKind::Single => {
                    if let Some(value) = resolve_slot(name, tokens, position, apps, context) {
                        result.valid_slots += 1;
                        result.slots.push(SlotAssignment {
                            name: name.clone(),
                            value,
                        });
                    } else if !optional {
                        result.missing = true;
                    }
                }
                SlotKind::Enum(values) => {
                    if let Some(value) = tokens.get(*position) {
                        if values.iter().any(|allowed| allowed == value) {
                            result.valid_slots += 1;
                            result.slots.push(SlotAssignment {
                                name: name.clone(),
                                value: SlotValue::Enum((*value).into()),
                            });
                            *position += 1;
                        } else if !optional {
                            result.missing = true;
                        }
                    } else if !optional {
                        result.missing = true;
                    }
                }
            }
        }
    }
    result.consumed = result.consumed.max(*position);
}

fn resolve_slot(
    name: &str,
    tokens: &[&str],
    position: &mut usize,
    apps: &[AppEntry],
    context: &Context,
) -> Option<SlotValue> {
    if name == "number" {
        let value = tokens.get(*position)?.parse::<i64>().ok()?;
        *position += 1;
        return Some(SlotValue::Number(value));
    }
    if name == "app" {
        let (value, consumed, confidence) = resolve_app_at(tokens.get(*position..)?, apps)?;
        if confidence < 0.5 {
            return None;
        }
        *position += consumed;
        return Some(SlotValue::App(value));
    }
    if name == "it" {
        if !matches!(tokens.get(*position), Some(&("it" | "that" | "this"))) {
            return None;
        }
        let app = context.last_app.clone()?;
        *position += 1;
        return Some(SlotValue::Context(app.name));
    }
    let value = tokens.get(*position)?.to_string();
    *position += 1;
    Some(SlotValue::Text(value))
}

fn resolve_app_list(tokens: &[&str], apps: &[AppEntry]) -> Vec<SlotValue> {
    let mut result = Vec::new();
    let mut start = 0;
    for i in 0..=tokens.len() {
        if i == tokens.len() || matches!(tokens[i], "and" | "also" | "plus") {
            if start < i {
                if let Some((app, _, confidence)) = resolve_app_at(&tokens[start..i], apps) {
                    if confidence >= 0.5 {
                        result.push(SlotValue::App(app));
                    }
                }
            }
            start = i + 1;
        }
    }
    result
}

fn resolve_app_at(tokens: &[&str], apps: &[AppEntry]) -> Option<(AppEntry, usize, f32)> {
    let mut best: Option<(AppEntry, usize, f32)> = None;
    for app in apps {
        for phrase in app.phrases() {
            let normalized_phrase = normalize(phrase);
            let phrase_tokens: Vec<&str> = normalized_phrase.split_whitespace().collect();
            if phrase_tokens.len() <= tokens.len()
                && tokens[..phrase_tokens.len()] == phrase_tokens[..]
            {
                let candidate = (app.clone(), phrase_tokens.len(), 1.0);
                if best
                    .as_ref()
                    .map(|current| candidate.1 > current.1)
                    .unwrap_or(true)
                {
                    best = Some(candidate);
                }
            }
        }
    }
    if best.is_some() {
        return best;
    }
    // A small deterministic edit-distance fallback handles common speech misspellings.
    let first = tokens.first()?;
    for app in apps {
        for phrase in app.phrases() {
            let normalized_phrase = normalize(phrase);
            let phrase_tokens: Vec<&str> = normalized_phrase.split_whitespace().collect();
            if phrase_tokens.len() == 1 {
                let distance = levenshtein(first, phrase_tokens[0]);
                let confidence = if distance == 1 { 0.75 } else { 0.0 };
                if confidence > 0.0
                    && best
                        .as_ref()
                        .map(|current| confidence > current.2)
                        .unwrap_or(true)
                {
                    best = Some((app.clone(), 1, confidence));
                }
            }
        }
    }
    best
}

fn levenshtein(a: &str, b: &str) -> usize {
    let mut row: Vec<usize> = (0..=b.len()).collect();
    for (i, a_byte) in a.bytes().enumerate() {
        let mut next = vec![i + 1; b.len() + 1];
        for (j, b_byte) in b.bytes().enumerate() {
            next[j + 1] =
                (next[j] + 1).min((row[j + 1] + 1).min(row[j] + usize::from(a_byte != b_byte)));
        }
        row = next;
    }
    row[b.len()]
}

fn expand_app_list(slots: Vec<SlotAssignment>) -> Vec<Vec<SlotAssignment>> {
    let app_slots: Vec<SlotAssignment> = slots
        .iter()
        .filter(|slot| {
            slot.name == "app+" || (slot.name == "app" && matches!(slot.value, SlotValue::App(_)))
        })
        .cloned()
        .collect();
    if app_slots.len() <= 1 {
        return vec![slots];
    }
    // `{app+}` is represented as repeated assignments and becomes one task per app.
    app_slots
        .into_iter()
        .map(|app| {
            slots
                .iter()
                .filter(|slot| slot.name != "app+" && slot.name != "app")
                .cloned()
                .chain(std::iter::once(app))
                .collect()
        })
        .collect()
}

pub trait AppLauncher {
    fn open(&self, app: &AppEntry) -> Result<(), String>;
}

#[derive(Clone, Copy, Debug, Default)]
pub struct LinuxAppLauncher;

impl AppLauncher for LinuxAppLauncher {
    fn open(&self, app: &AppEntry) -> Result<(), String> {
        use std::process::Stdio;
        // GUI apps run for a long time, so start them detached instead of waiting.
        Command::new(&app.command)
            .stdin(Stdio::null())
            .stdout(Stdio::null())
            .stderr(Stdio::null())
            .spawn()
            .map(|_| ())
            .map_err(|error| format!("could not launch {}: {error}", app.name))
    }
}

#[derive(Clone, Debug, PartialEq, Eq)]
pub struct TaskResult {
    pub task_id: u32,
    pub success: bool,
    pub message: String,
}

pub fn execute_open_tasks<L: AppLauncher>(plan: &Plan, launcher: &L) -> Vec<TaskResult> {
    plan.tasks
        .iter()
        .map(|task| {
            if task.action != "app.open" {
                return TaskResult {
                    task_id: task.id,
                    success: false,
                    message: format!("unsupported M1 action: {}", task.action),
                };
            }
            let app = task.args.iter().find_map(|arg| match &arg.value {
                SlotValue::App(app) => Some(app),
                _ => None,
            });
            match app {
                Some(app) => match launcher.open(app) {
                    Ok(()) => TaskResult {
                        task_id: task.id,
                        success: true,
                        message: format!("opened {}", app.name),
                    },
                    Err(error) => TaskResult {
                        task_id: task.id,
                        success: false,
                        message: error,
                    },
                },
                None => TaskResult {
                    task_id: task.id,
                    success: false,
                    message: "app.open requires an app slot".into(),
                },
            }
        })
        .collect()
}

#[derive(Default)]
struct Writer {
    bytes: Vec<u8>,
}

impl Writer {
    fn bytes(&mut self, value: &[u8]) {
        self.bytes.extend_from_slice(value);
    }
    fn u8(&mut self, value: u8) {
        self.bytes.push(value);
    }
    fn u16(&mut self, value: u16) {
        self.bytes.extend_from_slice(&value.to_le_bytes());
    }
    fn u32(&mut self, value: usize) -> Result<(), PackError> {
        let value =
            u32::try_from(value).map_err(|_| PackError("pack section is too large".into()))?;
        self.bytes.extend_from_slice(&value.to_le_bytes());
        Ok(())
    }
    fn string(&mut self, value: &str) -> Result<(), PackError> {
        self.u32(value.len())?;
        self.bytes(value.as_bytes());
        Ok(())
    }
    fn optional_string(&mut self, value: Option<&str>) -> Result<(), PackError> {
        match value {
            Some(value) => {
                self.u8(1);
                self.string(value)?;
            }
            None => self.u8(0),
        }
        Ok(())
    }
    fn into_inner(self) -> Vec<u8> {
        self.bytes
    }
}

fn write_strings(w: &mut Writer, values: &[String]) -> Result<(), PackError> {
    w.u32(values.len())?;
    for value in values {
        w.string(value)?;
    }
    Ok(())
}

fn write_pattern_token(w: &mut Writer, token: &PatternToken) -> Result<(), PackError> {
    match token {
        PatternToken::Literal(value) => {
            w.u8(0);
            w.string(value)?;
        }
        PatternToken::Slot { name, kind } => {
            w.u8(1);
            w.string(name)?;
            match kind {
                SlotKind::Single => w.u8(0),
                SlotKind::OneOrMore => w.u8(1),
                SlotKind::Rest => w.u8(2),
                SlotKind::Enum(values) => {
                    w.u8(3);
                    write_strings(w, values)?;
                }
            }
        }
        PatternToken::Optional(inner) => {
            w.u8(2);
            write_pattern_token(w, inner)?;
        }
    }
    Ok(())
}

fn read_pattern_token(r: &mut Reader<'_>) -> Result<PatternToken, PackError> {
    match r.u8()? {
        0 => Ok(PatternToken::Literal(r.string()?)),
        1 => {
            let name = r.string()?;
            let kind = match r.u8()? {
                0 => SlotKind::Single,
                1 => SlotKind::OneOrMore,
                2 => SlotKind::Rest,
                3 => SlotKind::Enum(r.strings()?),
                _ => return Err(PackError("invalid slot kind".into())),
            };
            Ok(PatternToken::Slot { name, kind })
        }
        2 => Ok(PatternToken::Optional(Box::new(read_pattern_token(r)?))),
        _ => Err(PackError("invalid pattern token".into())),
    }
}

struct Reader<'a> {
    bytes: &'a [u8],
    position: usize,
}

impl<'a> Reader<'a> {
    fn new(bytes: &'a [u8]) -> Self {
        Self { bytes, position: 0 }
    }
    fn take(&mut self, length: usize) -> Result<&'a [u8], PackError> {
        let end = self
            .position
            .checked_add(length)
            .ok_or_else(|| PackError("pack offset overflow".into()))?;
        if end > self.bytes.len() {
            return Err(PackError("truncated Hyde pack".into()));
        }
        let value = &self.bytes[self.position..end];
        self.position = end;
        Ok(value)
    }
    fn u8(&mut self) -> Result<u8, PackError> {
        Ok(*self.take(1)?.first().unwrap())
    }
    fn u16(&mut self) -> Result<u16, PackError> {
        Ok(u16::from_le_bytes(self.take(2)?.try_into().unwrap()))
    }
    fn u32(&mut self) -> Result<usize, PackError> {
        Ok(u32::from_le_bytes(self.take(4)?.try_into().unwrap()) as usize)
    }
    fn count(&mut self, what: &str) -> Result<usize, PackError> {
        let count = self.u32()?;
        if count > 1_000_000 {
            return Err(PackError(format!("{what} count is unreasonable")));
        }
        Ok(count)
    }
    fn string(&mut self) -> Result<String, PackError> {
        let length = self.count("string")?;
        String::from_utf8(self.take(length)?.to_vec())
            .map_err(|_| PackError("pack contains invalid UTF-8".into()))
    }
    fn optional_string(&mut self) -> Result<Option<String>, PackError> {
        Ok(if self.u8()? == 0 {
            None
        } else {
            Some(self.string()?)
        })
    }
    fn strings(&mut self) -> Result<Vec<String>, PackError> {
        let count = self.count("string")?;
        (0..count).map(|_| self.string()).collect()
    }
    fn is_empty(&self) -> bool {
        self.position == self.bytes.len()
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn pack() -> Pack {
        Pack {
            intents: vec![
                IntentDefinition {
                    id: "open_app".into(),
                    risk: Risk::L0,
                    parallel: true,
                    action: "app.open".into(),
                    response: Some("ok_opening".into()),
                    triggers: vec!["open".into(), "launch".into()],
                    patterns: vec![vec![
                        PatternToken::Literal("open".into()),
                        PatternToken::Slot {
                            name: "app+".into(),
                            kind: SlotKind::OneOrMore,
                        },
                    ]],
                },
                IntentDefinition {
                    id: "set_volume".into(),
                    risk: Risk::L0,
                    parallel: false,
                    action: "sys.volume.set".into(),
                    response: None,
                    triggers: vec!["volume".into()],
                    patterns: vec![vec![
                        PatternToken::Literal("volume".into()),
                        PatternToken::Slot {
                            name: "number".into(),
                            kind: SlotKind::Single,
                        },
                    ]],
                },
                IntentDefinition {
                    id: "close_app".into(),
                    risk: Risk::L1,
                    parallel: false,
                    action: "app.close".into(),
                    response: None,
                    triggers: vec!["close".into()],
                    patterns: vec![vec![
                        PatternToken::Literal("close".into()),
                        PatternToken::Slot {
                            name: "it".into(),
                            kind: SlotKind::Single,
                        },
                    ]],
                },
            ],
            apps: vec![
                AppEntry {
                    id: "chrome".into(),
                    name: "Google Chrome".into(),
                    aliases: vec!["chrome".into()],
                    command: "true".into(),
                },
                AppEntry {
                    id: "code".into(),
                    name: "Visual Studio Code".into(),
                    aliases: vec!["vs code".into()],
                    command: "true".into(),
                },
                AppEntry {
                    id: "spotify".into(),
                    name: "Spotify".into(),
                    aliases: vec![],
                    command: "true".into(),
                },
            ],
            vocabulary: vec!["open".into(), "chrome".into()],
        }
    }

    #[test]
    fn golden_open_apps_in_parallel() {
        let result =
            Matcher::new(&pack()).match_text("Please open Chrome and VS Code", &Context::default());
        assert_eq!(result.decision, Decision::Execute);
        assert_eq!(result.intent_ids, vec!["open_app"]);
        assert_eq!(result.tasks.len(), 2);
        assert!(result.tasks.iter().all(|task| task.depends_on.is_empty()));
    }

    #[test]
    fn golden_volume_words_are_normalized() {
        let result =
            Matcher::new(&pack()).match_text("set volume twenty five", &Context::default());
        // The pack's M1 pattern starts with `volume`; this remains a deliberate reject for
        // a non-matching synonym and confirms trigger/template behavior is deterministic.
        assert_eq!(result.decision, Decision::Reject);
        let result = Matcher::new(&pack()).match_text("volume twenty five", &Context::default());
        assert_eq!(result.decision, Decision::Execute);
        assert_eq!(result.tasks[0].args[0].value, SlotValue::Number(25));
    }

    #[test]
    fn golden_then_adds_dependencies() {
        let result =
            Matcher::new(&pack()).match_text("open Chrome then open Spotify", &Context::default());
        assert_eq!(result.decision, Decision::Execute);
        assert_eq!(result.tasks.len(), 2);
        assert_eq!(result.tasks[1].depends_on, vec![result.tasks[0].id]);
    }

    #[test]
    fn golden_context_slot_and_confirmation_threshold() {
        let context = Context {
            last_app: Some(pack().apps[0].clone()),
        };
        let result = Matcher::new(&pack()).match_text("close it", &context);
        assert_eq!(result.decision, Decision::Execute);
        assert_eq!(
            result.tasks[0].args[0].value,
            SlotValue::Context("Google Chrome".into())
        );
        let missing = Matcher::new(&pack()).match_text("open", &Context::default());
        assert_eq!(missing.decision, Decision::Confirm);
        assert!((0.55..0.80).contains(&missing.score));
    }

    #[test]
    fn packed_form_round_trips() {
        let original = pack();
        let bytes = original.to_bytes().unwrap();
        let restored = Pack::from_bytes(&bytes).unwrap();
        assert_eq!(original, restored);
        assert_eq!(bytes, restored.to_bytes().unwrap());
    }
}
