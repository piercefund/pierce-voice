# Pierce lookup tools for ElevenLabs staging

Do not attach either tool to a production agent or phone number until both staging tests pass.

## Shared authentication

For both webhook tools, add this request header:

- Header: `Authorization`
- Type: `Secret`
- Secret name: `PIERCE_CLOUDFLARE_TOOL_AUTHORIZATION`
- Secret value: paste the complete value copied by `scripts/deploy-elevenlabs-tools.sh`; it begins with `Bearer `

Use `application/json` for the request body. Do not add Cloudflare Access headers.

## Tool 1: O*NET career lookup

- Name: `lookup_onet_career`
- Method: `POST`
- URL: `https://pierce-voice-cloudflare-staging.piercefund.workers.dev/tools/lookup-onet-career`
- Description: `Look up verified O*NET occupation information when the participant names a career, occupation, role, or field they want to explore. Use the returned title, description, tasks, and source URL. Never invent an occupation or claim that a result is a job opening.`
- Response timeout: `20 seconds`

Body parameters:

| Key | Type | Required | Description |
| --- | --- | --- | --- |
| `query` | string | Yes | The occupation, career title, role, or field stated by the participant. Use a short search phrase, not the full conversation. |
| `limit` | integer | No | Number of matches to return, from 1 to 5. Use 3 unless a smaller result set is clearly better. |

## Tool 2: Pierce resource directory

- Name: `lookup_resource_directory`
- Method: `POST`
- URL: `https://pierce-voice-cloudflare-staging.piercefund.workers.dev/tools/lookup-resource-directory`
- Description: `Find the best fit from Pierce's fixed, approved career-resource directory. Call this only after understanding the participant's goal or challenge. Recommend only a returned resource, and repeat any eligibility note exactly enough to avoid implying guaranteed eligibility.`
- Response timeout: `10 seconds`

Body parameters:

| Key | Type | Required | Description |
| --- | --- | --- | --- |
| `query` | string | Yes | A short description of the participant's career goal, challenge, or requested support. |
| `location` | string | No | The participant's city and state or country when they have provided it. Never guess a location. |
| `limit` | integer | No | Number of approved resources to return, from 1 to 5. Use 3 for matching, then recommend exactly one. |

## System-prompt addition

Add this beneath the existing tool rules:

> Use `lookup_onet_career` only for verified occupation facts. Use `lookup_resource_directory` only to select from Pierce-approved resources. Never invent or substitute a URL, resource, eligibility rule, occupation, or tool result. For resource matching, call the directory with the participant's stated goal and their location only when known. Review up to three returned matches and recommend exactly one. State any returned eligibility caution. If either tool fails, say the lookup is temporarily unavailable and continue without inventing information.
