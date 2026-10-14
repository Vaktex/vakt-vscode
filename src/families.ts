// Mirrors internal/labels in the vakt repo (Families, display.go and
// DefaultThresholds) at the pinned weights vaktex/dom-oss-0.8b@d11d4db.
// The order is the model head's output order. If the weights move, update
// this file together with brand.ModelCommit there.

export const FAMILIES = [
  "access_control",
  "authentication",
  "authorization",
  "communication_security",
  "credentials_and_secrets",
  "cryptographic_issues",
  "data_neutralization",
  "data_processing",
  "error_handling",
  "file_and_path",
  "initialization_and_cleanup",
  "memory_safety",
  "resource_management",
  "serialization_and_parsing",
  "session_management",
  "synchronization_and_concurrency",
  "web_security",
  "other",
] as const;

export type Family = (typeof FAMILIES)[number];

export function isFamily(name: string): name is Family {
  return (FAMILIES as readonly string[]).includes(name);
}

interface Issue {
  title: string;
  cwe?: string;
  /** One line in plain words, for the hover and other tight spots. */
  summary: string;
  /** The CWE entry's own description (cwe.mitre.org), shown in the detail panel. */
  description: string;
}

const ISSUES: Record<Family, Issue> = {
  access_control: {
    title: "Access control flaw",
    cwe: "CWE-284",
    summary: "A resource may be reachable by someone who should not have access to it.",
    description: "The product does not restrict or incorrectly restricts access to a resource from an unauthorized actor.",
  },
  authentication: {
    title: "Broken authentication",
    cwe: "CWE-287",
    summary: "An identity claim may be accepted without being properly verified.",
    description: "When an actor claims to have a given identity, the product does not prove or insufficiently proves that the claim is correct.",
  },
  authorization: {
    title: "Missing authz check",
    cwe: "CWE-862",
    summary: "An action may run without checking that the caller is allowed to do it.",
    description: "The product does not perform an authorization check when an actor attempts to access a resource or perform an action.",
  },
  communication_security: {
    title: "Insecure communication",
    cwe: "CWE-319",
    summary: "Sensitive data may travel over an unencrypted channel.",
    description:
      "The product transmits sensitive or security-critical data in cleartext in a communication channel that can be sniffed by unauthorized actors.",
  },
  credentials_and_secrets: {
    title: "Hardcoded secret",
    cwe: "CWE-798",
    summary: "A password, token or key may be written into the code.",
    description: "The product contains hard-coded credentials, such as a password or cryptographic key.",
  },
  cryptographic_issues: {
    title: "Weak cryptography",
    cwe: "CWE-327",
    summary: "A broken or risky cryptographic algorithm may be in use.",
    description: "The product uses a broken or risky cryptographic algorithm or protocol.",
  },
  // Improper neutralization in general: SQL, commands, templates, markup. Not only SQL.
  data_neutralization: {
    title: "Injection",
    cwe: "CWE-74",
    summary: "Untrusted input may reach a query, command or page without being escaped.",
    description:
      "The product constructs all or part of a command, data structure, or record using externally-influenced input from an upstream component, but it does not neutralize or incorrectly neutralizes special elements that could modify how it is parsed or interpreted when it is sent to a downstream component.",
  },
  data_processing: {
    title: "Unsafe data processing",
    cwe: "CWE-20",
    summary: "Input may be used without checking that it is safe to process.",
    description:
      "The product receives input or data, but it does not validate or incorrectly validates that the input has the properties that are required to process the data safely and correctly.",
  },
  error_handling: {
    title: "Information leak in errors",
    cwe: "CWE-209",
    summary: "Error messages may expose internal details or sensitive data.",
    description: "The product generates an error message that includes sensitive information about its environment, users, or associated data.",
  },
  file_and_path: {
    title: "Path traversal",
    cwe: "CWE-22",
    summary: "A path built from input may escape its intended directory.",
    description:
      "The product uses external input to construct a pathname that is intended to identify a file or directory that is located underneath a restricted parent directory, but the product does not properly neutralize special elements within the pathname that can cause the pathname to resolve to a location that is outside of the restricted directory.",
  },
  initialization_and_cleanup: {
    title: "Unsafe init or cleanup",
    cwe: "CWE-665",
    summary: "A resource may be used before it is set up correctly, or not cleaned up.",
    description:
      "The product does not initialize or incorrectly initializes a resource, which might leave the resource in an unexpected state when it is accessed or used.",
  },
  memory_safety: {
    title: "Buffer overflow",
    cwe: "CWE-120",
    summary: "A copy may write past the end of a buffer.",
    description:
      "The product copies an input buffer to an output buffer without verifying that the size of the input buffer is less than the size of the output buffer, leading to a buffer overflow.",
  },
  resource_management: {
    title: "Resource leak",
    cwe: "CWE-400",
    summary: "Input may be able to exhaust memory, connections or other resources.",
    description:
      "The product does not properly control the allocation and maintenance of a limited resource, thereby enabling an actor to influence the amount of resources consumed, eventually leading to the exhaustion of available resources.",
  },
  serialization_and_parsing: {
    title: "Unsafe deserialization",
    cwe: "CWE-502",
    summary: "Untrusted data may be deserialized without validation.",
    description: "The product deserializes untrusted data without sufficiently ensuring that the resulting data will be valid.",
  },
  session_management: {
    title: "Session fixation",
    cwe: "CWE-384",
    summary: "A session identifier may survive login and be taken over.",
    description:
      "Authenticating a user, or otherwise establishing a new user session, without invalidating any existing session identifier gives an attacker the opportunity to steal authenticated sessions.",
  },
  synchronization_and_concurrency: {
    title: "Race condition",
    cwe: "CWE-362",
    summary: "Concurrent code may race on shared state.",
    description:
      "The product contains a concurrent code sequence that requires temporary, exclusive access to a shared resource, but a timing window exists in which the shared resource can be modified by another code sequence operating concurrently.",
  },
  web_security: {
    title: "Cross-site scripting",
    cwe: "CWE-79",
    summary: "User input may be written into a page without escaping.",
    description:
      "The product does not neutralize or incorrectly neutralizes user-controllable input before it is placed in output that is used as a web page that is served to other users.",
  },
  other: {
    title: "Security issue",
    summary: "This function may contain a security weakness.",
    description: "DOM-0.8B flagged a security weakness that does not fit one of its named families.",
  },
};

// F1-optimal per-family cut-offs published with the pinned weights.
export const DEFAULT_THRESHOLDS: Record<Family, number> = {
  access_control: 0.3066038843350505,
  authentication: 0.2928365884080407,
  authorization: 0.2845438533372397,
  communication_security: 0.22084363956391176,
  credentials_and_secrets: 0.3395179034181917,
  cryptographic_issues: 0.17693129806181332,
  data_neutralization: 0.21428010703490563,
  data_processing: 0.14725222836749954,
  error_handling: 0.11061918228642885,
  file_and_path: 0.17032466822271736,
  initialization_and_cleanup: 0.12121400925811497,
  memory_safety: 0.2832721713234602,
  resource_management: 0.24380708177967444,
  serialization_and_parsing: 0.14046872348128342,
  session_management: 0.31703013639211025,
  synchronization_and_concurrency: 0.05352505482257432,
  web_security: 0.3382818172097932,
  other: 0.07727904300183096,
};

export function issueFor(family: string): Issue {
  return isFamily(family) ? ISSUES[family] : { ...ISSUES.other, title: family || ISSUES.other.title };
}

/** "Injection (CWE-74)", or the title alone when no single CWE fits. */
export function displayTitle(family: string): string {
  const { title, cwe } = issueFor(family);
  return cwe ? `${title} (${cwe})` : title;
}

export function cweUrl(cwe: string): string | undefined {
  const m = /^CWE-(\d+)$/.exec(cwe);
  return m ? `https://cwe.mitre.org/data/definitions/${m[1]}.html` : undefined;
}

export interface RankedFamily {
  family: Family;
  prob: number;
  cutoff: number;
  /** prob / cutoff: how far the score clears the published cut-off. */
  ratio: number;
}

/**
 * A family and the broader one it is a kind of (vakt's labels.Narrower). XSS
 * is an improper neutralization, and the model scores both on the same code,
 * the broad one higher: once XSS clears its own cut-off it names the finding.
 */
const NARROWER: Partial<Record<Family, Family>> = { web_security: "data_neutralization" };

/**
 * Families ordered the way vakt picks top_family: by how far each clears its
 * cut-off, not by raw probability (rare families have cut-offs far below 0.5),
 * with a narrower family that clears its cut-off ahead of its broader one.
 */
export function rankFamilies(probs: Partial<Record<string, number>>, n = 3): RankedFamily[] {
  const ranked = FAMILIES.map((family) => {
    const prob = probs[family] ?? 0;
    const cutoff = DEFAULT_THRESHOLDS[family];
    return { family, prob, cutoff, ratio: prob / cutoff };
  }).sort((a, b) => b.ratio - a.ratio);
  for (const [narrow, broad] of Object.entries(NARROWER) as [Family, Family][]) {
    const i = ranked.findIndex((r) => r.family === narrow);
    const j = ranked.findIndex((r) => r.family === broad);
    if (j < i && ranked[i].ratio >= 1) ranked.splice(j, 0, ...ranked.splice(i, 1));
  }
  return ranked.slice(0, n);
}

/**
 * The unit with top_family chosen as vakt now chooses it. Results stored by
 * an older vakt named the broad family; re-ranking keeps them consistent.
 */
export function withTopFamily<T extends { families: Partial<Record<string, number>>; top_family: string; top_family_prob: number }>(u: T): T {
  if (!u.top_family) return u;
  const [top] = rankFamilies(u.families, 1);
  return top && top.family !== u.top_family && NARROWER[top.family] === u.top_family
    ? { ...u, top_family: top.family, top_family_prob: top.prob }
    : u;
}

/** CRITICAL / HIGH / MEDIUM / LOW, matching report.SeverityLabel. */
export function severityLabel(score: number): string {
  if (score >= 0.85) return "CRITICAL";
  if (score >= 0.7) return "HIGH";
  if (score >= 0.5) return "MEDIUM";
  return "LOW";
}
