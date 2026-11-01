export type Explanation = { cause: string; next: string };

type Rule = { pattern: RegExp; id: string; cause: string; next: string };

const rules: Rule[] = [
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
    pattern: /connection refused|ENOTFOUND|name or service not known|timeout|timed out/i,
    id: "endpoint-unreachable",
    cause: "The configured endpoint is unreachable.",
    next: "Check DNS, network access, and the endpoint host.",
  },
  {
    pattern: /x-amz-checksum-|x-amz-sdk-checksum-algorithm|checksum.*(?:unsupported|not support|reject)/i,
    id: "checksum-rejected",
    cause: "The S3-compatible endpoint rejected an AWS checksum header.",
    next: "Try skip_s3_checksum or set AWS_REQUEST_CHECKSUM_CALCULATION and AWS_RESPONSE_CHECKSUM_VALIDATION to when_required.",
  },
];

export function explain(diagnostic: string): Explanation | undefined {
  const rule = rules.find(({ pattern }) => pattern.test(diagnostic));
  return rule ? { cause: rule.cause, next: rule.next } : undefined;
}
