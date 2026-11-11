export type Explanation = { cause: string; next: string };

type Rule = { pattern: RegExp; id: string; cause: string; next: string };

// GitHub answers 404, not 403, when a token cannot see an organization or enterprise setting.
const GITHUB_DENIED = String.raw`[^\n]{0,300}?\b(?:403|404)\b`;
const rules: Rule[] = [
  {
    pattern: /\b401\b[^\n]{0,100}Bad credentials|Bad credentials[^\n]{0,100}\b401\b/i,
    id: "github-bad-credentials",
    cause: "GitHub rejected the token itself: it is invalid, expired, or revoked.",
    next: "Issue a new token or GitHub App installation token and update the provider credential.",
  },
  {
    pattern: new RegExp(String.raw`/enterprises/${GITHUB_DENIED}`, "i"),
    id: "github-enterprise-permission",
    cause: "GitHub denied an enterprise request; 404 here usually means missing permission, not a missing resource.",
    next: "Use an enterprise owner's classic token with admin:enterprise, or manage_runners:enterprise for runners and runner groups.",
  },
  {
    pattern: new RegExp(String.raw`/(?:actions/runner-groups|actions/runners)\b${GITHUB_DENIED}`, "i"),
    id: "github-runner-permission",
    cause:
      "GitHub denied a self-hosted runner or runner group request; 404 here usually means missing permission, not a missing resource.",
    next: "Grant admin:org (classic token, organization owner), or Self-hosted runners read and write (fine-grained token or GitHub App organization permission).",
  },
  {
    pattern: /Resource not accessible by (?:integration|personal access token)/i,
    id: "github-token-permission",
    cause: "The GitHub App or fine-grained token lacks a permission this resource needs.",
    next: "Add the missing repository or organization permission to the app or token (an app needs reapproval), then retry.",
  },
  {
    pattern: new RegExp(String.raw`/orgs/${GITHUB_DENIED}`, "i"),
    id: "github-org-permission",
    cause: "GitHub denied an organization request; 404 here usually means missing permission, not a missing resource.",
    next: "Grant admin:org (classic token, organization owner), or the matching organization permission such as Administration (fine-grained token or GitHub App).",
  },
  {
    pattern: new RegExp(String.raw`/repos/${GITHUB_DENIED}|Must have admin rights to Repository`, "i"),
    id: "github-repo-permission",
    cause: "GitHub denied a repository request; 404 here usually means missing permission, not a missing resource.",
    next: "Grant repo (classic token), or Administration read and write on the repository (fine-grained token or GitHub App); the token's user must be a repository admin.",
  },
  {
    pattern: /not authorized to perform|UnauthorizedOperation/i,
    id: "aws-iam-permission",
    cause: "The AWS caller lacks an IAM permission for this operation.",
    next: "Grant the denied action (missing_permission when shown) to the calling principal, and check SCPs and permission boundaries.",
  },
  {
    pattern: /ExpiredToken|RequestExpired|security token included in the request is expired/i,
    id: "aws-expired-credentials",
    cause: "The AWS credentials or session token have expired.",
    next: "Refresh the AWS session, for example by logging in to SSO again, then retry.",
  },
  {
    pattern:
      /403.{0,100}(?:cap exceeded|download_cap_exceeded|transaction_cap_exceeded)|(?:cap exceeded|download_cap_exceeded|transaction_cap_exceeded)/i,
    id: "b2-cap-exceeded",
    cause:
      "Not a credentials problem. B2 refused because a daily cap was reached (download bandwidth or Class B/C transactions).",
    next: "Raise the cap in the B2 web console (Caps & Alerts) or wait for the daily reset.",
  },
  {
    pattern: /InvalidAccessKeyId/i,
    id: "invalid-access-key",
    cause: "The key ID is wrong or missing.",
    next: "Check the AWS_* credential mapping and the B2 application key ID.",
  },
  {
    pattern: /SignatureDoesNotMatch/i,
    id: "signature-mismatch",
    cause: "The key ID was found, but the secret may be wrong or a stray session token may be present.",
    next: "Check AWS_SECRET_ACCESS_KEY and unset AWS_SESSION_TOKEN for B2.",
  },
  {
    pattern: /AccessDenied/i,
    id: "access-denied",
    cause: "The key may lack capability for this bucket or prefix.",
    next: "Check the B2 key's bucket and prefix restrictions.",
  },
  {
    pattern: /NoSuchBucket/i,
    id: "no-such-bucket",
    cause: "The bucket name or endpoint region may be incorrect.",
    next: "Check the bucket name and endpoint region.",
  },
  {
    pattern:
      /connection refused|ENOTFOUND|name or service not known|(?:connection|endpoint).{0,80}(?:timeout|timed out)|(?:timeout|timed out).{0,80}(?:connection|endpoint)/i,
    id: "endpoint-unreachable",
    cause: "The configured endpoint is unreachable.",
    next: "Check DNS, network access, and the endpoint host.",
  },
  {
    pattern:
      /(?=.*(?:x-amz-checksum-[\w-]+|x-amz-sdk-checksum-algorithm))(?=.*(?:unsupported|not supported|reject(?:ed|ion)?|invalid header))/i,
    id: "checksum-rejected",
    cause: "The S3-compatible endpoint rejected an AWS checksum header.",
    next: "Try skip_s3_checksum or set AWS_REQUEST_CHECKSUM_CALCULATION and AWS_RESPONSE_CHECKSUM_VALIDATION to when_required.",
  },
];

/** Every explanation is fixed text; the diagnostic is only matched, never echoed. */
export function explain(diagnostic: string): Explanation | undefined {
  const rule = rules.find(({ pattern }) => pattern.test(diagnostic));
  return rule ? { cause: rule.cause, next: rule.next } : undefined;
}
