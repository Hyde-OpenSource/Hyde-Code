<!-- Draft prepared with an AI assistant. Have it reviewed (ideally by a lawyer) before relying on it. When you change it, bump TERMS_VERSION in apps/hub/src/home.ts so everyone is asked to accept again. -->

# Hyde Code Terms of Use

Version 2026-10-29

By running `hyde` in a folder, adding a project in the dashboard, or otherwise using Hyde
Code ("the software"), you agree to these terms. If you do not agree, do not use it.

## 1. What Hyde Code does
Hyde Code is software you run on your own machine. It starts AI coding agents (such as
Claude Code, Codex, OpenCode and others) **under your own accounts and logins**, lets them
read and change files in folders you trust, run commands there, and, with your approval,
push branches and open or merge pull requests.

## 2. Trusted folders
When you trust a folder, the agents may read any file in it, change files, and run
commands in copies (git worktrees) of it. Only trust folders whose contents you are
allowed to share with the AI services you use, and that contain no secrets you do not want
those services to see. You can stop trusting a folder at any time with `hyde forget`.

## 3. Your accounts and third-party services
Hyde Code does not provide any AI model. Every agent runs through a third-party tool and
service (for example Anthropic, OpenAI or others) that has its own terms, usage limits and
privacy policy. You are responsible for following them, for any usage or costs on your
accounts, and for anything you send to those services. Chat apps you connect (Telegram,
Slack, Discord, WhatsApp) are governed by their own terms too.

## 4. Your responsibility for the work
AI agents make mistakes. You are responsible for reviewing what they produce before you
merge, deploy or ship it, and for the commands, branches and changes you approve. Hyde
Code's checks, reviews and policies reduce risk; they do not remove it.

## 5. Your data
Hyde Code stores its settings, history and tokens on your machine (in `~/.hyde`). It does
not send your code or data to the authors of Hyde Code and has no telemetry. Data does go
to the AI services and chat apps you choose to use, under their terms.

## 6. Acceptable use
Do not use Hyde Code to break the law, to attack or access systems you are not allowed to,
to infringe others' rights, or to break the terms of the services it connects to.

## 7. No warranty
The software is provided "as is", without warranty of any kind, express or implied,
including fitness for a particular purpose. Use it at your own risk.

## 8. Limitation of liability
To the fullest extent the law allows, the authors and contributors of Hyde Code are not
liable for any damages arising from its use, including lost data, lost profits, damaged
repositories, service charges, or account suspensions.

## 9. Third-party components
Hyde Code includes open-source components under their own licences (see the Credits
section of the README). Optional art you import yourself (for example LimeZu tiles) stays
under its own licence.

## 10. Changes
These terms may change. When they do, the version above changes and Hyde Code asks you to
accept the new version before you continue.
