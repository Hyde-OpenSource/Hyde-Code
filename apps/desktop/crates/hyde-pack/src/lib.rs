use hyde_core::{
    normalize, AppEntry, IntentDefinition, Pack, PackError, PatternToken, Risk, SlotKind,
};
use serde::Deserialize;
use std::fs;
use std::path::{Path, PathBuf};

#[derive(Debug)]
pub enum CompileError {
    Io(String),
    Toml { path: String, message: String },
    Invalid { path: String, message: String },
    Pack(PackError),
}

impl std::fmt::Display for CompileError {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        match self {
            Self::Io(message) => write!(f, "I/O error: {message}"),
            Self::Toml { path, message } => write!(f, "invalid TOML in {path}: {message}"),
            Self::Invalid { path, message } => write!(f, "invalid data in {path}: {message}"),
            Self::Pack(error) => error.fmt(f),
        }
    }
}

impl std::error::Error for CompileError {}

impl From<PackError> for CompileError {
    fn from(value: PackError) -> Self {
        Self::Pack(value)
    }
}

#[derive(Debug, Deserialize)]
struct IntentFile {
    #[serde(default)]
    intent: Vec<RawIntent>,
}

#[derive(Debug, Deserialize)]
struct RawIntent {
    id: String,
    risk: String,
    #[serde(default)]
    parallel: bool,
    action: String,
    #[serde(default)]
    response: Option<String>,
    #[serde(default)]
    triggers: Vec<String>,
    patterns: Vec<String>,
}

#[derive(Debug, Deserialize)]
struct AppFile {
    #[serde(default)]
    app: Vec<RawApp>,
}

#[derive(Debug, Deserialize)]
struct RawApp {
    id: String,
    name: String,
    #[serde(default)]
    aliases: Vec<String>,
    command: String,
}

/// A named TOML document, either read from disk or embedded in a binary.
pub struct Source {
    pub name: String,
    pub contents: String,
}

impl Source {
    pub fn new(name: impl Into<String>, contents: impl Into<String>) -> Self {
        Self {
            name: name.into(),
            contents: contents.into(),
        }
    }
}

pub fn compile_directory(source: impl AsRef<Path>) -> Result<Pack, CompileError> {
    let source = source.as_ref();
    let intents_dir = source.join("intents");
    let intent_files = sorted_toml_files(&intents_dir)?;
    if intent_files.is_empty() {
        return Err(CompileError::Invalid {
            path: intents_dir.display().to_string(),
            message: "no intent TOML files found".into(),
        });
    }
    let intents = intent_files
        .iter()
        .map(|path| read_source(path))
        .collect::<Result<Vec<_>, _>>()?;
    let apps_path = source.join("apps.toml");
    let apps = if apps_path.exists() {
        Some(read_source(&apps_path)?)
    } else {
        None
    };
    compile_sources(&intents, apps.as_ref())
}

fn read_source(path: &Path) -> Result<Source, CompileError> {
    let contents = fs::read_to_string(path)
        .map_err(|error| CompileError::Io(format!("{}: {error}", path.display())))?;
    Ok(Source::new(path.display().to_string(), contents))
}

/// Compiles intent documents plus an optional app catalogue into a pack.
pub fn compile_sources(
    intent_sources: &[Source],
    apps: Option<&Source>,
) -> Result<Pack, CompileError> {
    let mut intents = Vec::new();
    let mut vocabulary = Vec::new();
    let mut seen = std::collections::BTreeSet::new();
    for source in intent_sources {
        let path = &source.name;
        let file: IntentFile =
            toml::from_str(&source.contents).map_err(|error| CompileError::Toml {
                path: path.clone(),
                message: error.to_string(),
            })?;
        for raw in file.intent {
            if raw.id.trim().is_empty() || raw.action.trim().is_empty() || raw.patterns.is_empty() {
                return Err(CompileError::Invalid {
                    path: path.clone(),
                    message: "intent requires id, action, and at least one pattern".into(),
                });
            }
            if !seen.insert(raw.id.clone()) {
                return Err(CompileError::Invalid {
                    path: path.clone(),
                    message: format!("duplicate intent id `{}`", raw.id),
                });
            }
            let risk = Risk::from_str(&raw.risk).map_err(|error| CompileError::Invalid {
                path: path.clone(),
                message: error.to_string(),
            })?;
            let mut patterns = Vec::new();
            for pattern in &raw.patterns {
                let parsed = parse_pattern(pattern).map_err(|message| CompileError::Invalid {
                    path: path.clone(),
                    message: format!("pattern `{pattern}`: {message}"),
                })?;
                vocabulary.extend(pattern_vocabulary(&parsed));
                patterns.push(parsed);
            }
            for trigger in &raw.triggers {
                vocabulary.extend(normalize(trigger).split_whitespace().map(str::to_owned));
            }
            intents.push(IntentDefinition {
                id: raw.id,
                risk,
                parallel: raw.parallel,
                action: raw.action,
                response: raw.response,
                triggers: raw
                    .triggers
                    .into_iter()
                    .map(|trigger| normalize(&trigger))
                    .collect(),
                patterns,
            });
        }
    }

    let apps = match apps {
        Some(source) => read_apps(source, &mut vocabulary)?,
        None => Vec::new(),
    };
    vocabulary.sort_unstable();
    vocabulary.dedup();
    Ok(Pack {
        intents,
        apps,
        vocabulary,
    })
}

pub fn compile_to_file(
    source: impl AsRef<Path>,
    output: impl AsRef<Path>,
) -> Result<usize, CompileError> {
    let pack = compile_directory(source)?;
    let bytes = pack.to_bytes()?;
    fs::write(output.as_ref(), &bytes)
        .map_err(|error| CompileError::Io(format!("{}: {error}", output.as_ref().display())))?;
    Ok(bytes.len())
}

fn sorted_toml_files(directory: &Path) -> Result<Vec<PathBuf>, CompileError> {
    let entries = fs::read_dir(directory)
        .map_err(|error| CompileError::Io(format!("{}: {error}", directory.display())))?;
    let mut files = entries
        .filter_map(|entry| entry.ok().map(|entry| entry.path()))
        .filter(|path| path.extension().and_then(|extension| extension.to_str()) == Some("toml"))
        .collect::<Vec<_>>();
    files.sort();
    Ok(files)
}

fn read_apps(source: &Source, vocabulary: &mut Vec<String>) -> Result<Vec<AppEntry>, CompileError> {
    let path = &source.name;
    let file: AppFile = toml::from_str(&source.contents).map_err(|error| CompileError::Toml {
        path: path.clone(),
        message: error.to_string(),
    })?;
    let mut apps = Vec::new();
    for raw in file.app {
        if raw.id.trim().is_empty() || raw.name.trim().is_empty() || raw.command.trim().is_empty() {
            return Err(CompileError::Invalid {
                path: path.clone(),
                message: "app requires id, name, and command".into(),
            });
        }
        vocabulary.extend(normalize(&raw.name).split_whitespace().map(str::to_owned));
        for alias in &raw.aliases {
            vocabulary.extend(normalize(alias).split_whitespace().map(str::to_owned));
        }
        apps.push(AppEntry {
            id: raw.id,
            name: raw.name,
            aliases: raw.aliases,
            command: raw.command,
        });
    }
    Ok(apps)
}

pub fn parse_pattern(pattern: &str) -> Result<Vec<PatternToken>, String> {
    let mut result = Vec::new();
    for raw in pattern.split_whitespace() {
        if raw.starts_with('[') || raw.ends_with(']') {
            if !(raw.starts_with('[') && raw.ends_with(']')) {
                return Err("optional slot must be enclosed in one token, e.g. `[{when}]`".into());
            }
            let inner = raw.trim_start_matches('[').trim_end_matches(']');
            result.push(PatternToken::Optional(Box::new(parse_token(inner)?)));
        } else if normalize(raw).is_empty() && !raw.contains(['{', '}']) {
            // Filler words ("please", "can", "you") are dropped from input, so drop them here too.
            continue;
        } else {
            result.push(parse_token(raw)?);
        }
    }
    if result.is_empty() {
        return Err("pattern is empty".into());
    }
    Ok(result)
}

fn parse_token(raw: &str) -> Result<PatternToken, String> {
    if raw.contains(['{', '}']) {
        if !(raw.starts_with('{') && raw.ends_with('}'))
            || raw[1..raw.len() - 1].contains(['{', '}'])
        {
            return Err("slot braces are unbalanced".into());
        }
        let body = &raw[1..raw.len() - 1];
        let (name, modifier) = body
            .split_once(':')
            .map_or((body, None), |(name, modifier)| (name, Some(modifier)));
        if name.is_empty() {
            return Err("slot name is empty".into());
        }
        let kind = match modifier {
            Some(values) => SlotKind::Enum(values.split('|').map(normalize).collect()),
            None if name.ends_with('+') => SlotKind::OneOrMore,
            None if name.ends_with('*') => SlotKind::Rest,
            None => SlotKind::Single,
        };
        let name = name.trim_end_matches(['+', '*']).to_string();
        Ok(PatternToken::Slot { name, kind })
    } else {
        let normalized = normalize(raw);
        if normalized.split_whitespace().count() != 1 {
            return Err("literal must be one token".into());
        }
        Ok(PatternToken::Literal(normalized))
    }
}

fn pattern_vocabulary(pattern: &[PatternToken]) -> Vec<String> {
    pattern
        .iter()
        .flat_map(|token| match token {
            PatternToken::Literal(value) => vec![value.clone()],
            PatternToken::Slot {
                kind: SlotKind::Enum(values),
                ..
            } => values.clone(),
            PatternToken::Optional(inner) => pattern_vocabulary(std::slice::from_ref(inner)),
            PatternToken::Slot { .. } => Vec::new(),
        })
        .collect()
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn parses_requested_pattern_forms() {
        assert_eq!(
            parse_pattern("{trigger} {app+}").unwrap()[1],
            PatternToken::Slot {
                name: "app".into(),
                kind: SlotKind::OneOrMore
            }
        );
        assert_eq!(parse_pattern("volume {dir:up|down}").unwrap().len(), 2);
        assert!(parse_pattern("broken{").is_err());
    }
}
