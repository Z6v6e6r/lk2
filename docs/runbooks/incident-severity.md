# Incident severity

| Severity | Examples                                                         | Required response                                              |
| -------- | ---------------------------------------------------------------- | -------------------------------------------------------------- |
| P0       | data loss, duplicate charge, mass booking failure, data exposure | immediate paging, contain dangerous function, incident command |
| P1       | Viva unavailable, broad 5xx, stalled queue or major sync lag     | urgent alert and incident                                      |
| P2       | one module/station broken, isolated push failure                 | working-group notification and tracked fix                     |
| P3       | isolated errors, slow noncritical query, minor drift             | dashboard and daily digest                                     |

Alerts must deduplicate, escalate sustained impact, include tenant/endpoint/release/correlation ID, link to dashboards/logs/runbooks and resolve on verified recovery.
