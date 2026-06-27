---
"@omniforge/mission-control": patch
---

ClickUp ticket sync now retries transient transport failures (e.g. `read ETIMEDOUT`) with bounded backoff, and defers a single task whose comment fetch fails transiently to the next polling interval instead of aborting the whole autonomy tick with an unhandled `fetch failed`. Retry applies only to idempotent reads and status updates; comment creation is a single-attempt POST so a read timeout after ClickUp accepts it cannot post duplicate pickup/completion comments.
