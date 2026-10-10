// Text shown for a unit. No vscode import, so it is unit-testable.

import { displayTitle, issueFor, rankFamilies, severityLabel } from "./families";
import { sanitize, Unit } from "./report";

/** Extensions with a vakt tree-sitter grammar (README "Languages with a grammar"). Scan-on-save is limited to these. */
const GRAMMAR_EXTENSIONS = new Set([
  ".py", ".pyw", ".pyi",
  ".js", ".mjs", ".cjs", ".jsx",
  ".ts", ".mts", ".cts", ".tsx",
  ".go", ".rs", ".java",
  ".c", ".h", ".cc", ".cpp", ".cxx", ".c++", ".hh", ".hpp", ".hxx", ".ipp", ".inl",
  ".cs", ".php", ".phtml", ".rb", ".rake",
  ".sh", ".bash", ".zsh",
  ".kt", ".kts", ".scala", ".sc", ".lua", ".sol",
  ".tf", ".tfvars", ".hcl",
  ".bas", ".cls", ".frm", ".vba",
]);

export function hasGrammar(file: string): boolean {
  const dot = file.lastIndexOf(".");
  return dot > file.lastIndexOf("/") && GRAMMAR_EXTENSIONS.has(file.slice(dot).toLowerCase());
}

export function fmt(score: number): string {
  return score >= 0.9995 ? score.toFixed(4) : score.toFixed(2);
}

export function unitName(u: Unit): string {
  // Unnamed code (top-level or a whole file scored as one unit) is named by where it starts.
  return sanitize(u.name, 120) || `Line ${u.start_line}`;
}

/** The Problems-panel message: the issue and, in one sentence, what it means. Details live in the panel. */
export function diagnosticMessage(u: Unit): string {
  const explanation = u.explanation ? sanitize(u.explanation, 300) : "";
  return `${displayTitle(u.top_family)}: ${explanation || issueFor(u.top_family).summary}`;
}

/** The code lens's main action. The squiggle and Problems entry already name the issue. */
export function codeLensTitle(): string {
  return "$(vakt-logo) Review";
}

export function reviewTooltip(u: Unit): string {
  return `Review ${displayTitle(u.top_family)} in ${unitName(u)}`;
}

/** Where Resolve sends a finding: the editor's own agent if it has one, else the clipboard. */
export type AgentTarget = "cursor" | "vscode-agent" | "clipboard";

/**
 * Cursor and VS Code both implement workbench.action.chat.open. In Cursor it
 * opens a new agent chat with the prompt filled in (the user presses Enter);
 * in VS Code (Copilot) it can open agent mode and send it.
 */
export function agentTarget(appName: string, commands: readonly string[]): AgentTarget {
  if (!commands.includes("workbench.action.chat.open")) return "clipboard";
  return /cursor/i.test(appName) ? "cursor" : "vscode-agent";
}

/**
 * A prompt for a coding agent or reviewer model, containing only this
 * function and its scores. Sending the few functions that scored high rather
 * than the whole repo is the token-saving workflow the README describes.
 */
export function reviewPrompt(u: Unit, source: string, languageId: string): string {
  const fams = rankFamilies(u.families)
    .map((r) => `- ${displayTitle(r.family)}: ${fmt(r.prob)} (cut-off ${r.cutoff.toFixed(2)})`)
    .join("\n");
  const fence = source.includes("```") ? "~~~~" : "```";
  return [
    `A local code-security model (DOM-0.8B, via VAKT) flagged this function for review.`,
    `File: ${sanitize(u.file, 400)}, lines ${u.start_line}-${u.end_line}`,
    `Severity: ${fmt(u.severity)} (${severityLabel(u.severity)})`,
    `Top families:\n${fams}`,
    "",
    "Review it and fix it:",
    "1. The score is a lead, not a verdict. Read the function in context (its callers, where its inputs come from, configuration) and decide whether this is a real, reachable vulnerability.",
    "2. If it is, explain the attack in a sentence or two, then fix it in place with the smallest change that removes it, keeping the function's behaviour otherwise the same.",
    "3. If it is not, say why and change nothing.",
    "",
    `${fence}${languageId}`,
    source,
    fence,
  ].join("\n");
}
