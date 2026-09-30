# Security boundaries

TokenPilot runs trusted local project checks as your user. Its desktop app is not an OS sandbox. Arbitrary agent commands require approval. Optional Docker probes are separately constrained; Docker is not a guarantee against every kernel or runtime vulnerability.

Scanner snapshots contain original source and can contain credentials. Local history and logs are not encrypted. Exports apply pattern redaction but cannot recognize all secrets. Do not attach confidential source or active credentials to a public issue.

For a reproducible vulnerability report, use an inert synthetic fixture and state which boundary failed. If the repository is published with GitHub private vulnerability reporting enabled, use that private channel for sensitive details.
