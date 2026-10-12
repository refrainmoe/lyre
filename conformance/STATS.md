# §16 observed maxima — conformance corpus

Published per §12 (`lyre-validate stats`), keeping the §16 ceilings anchored to
measured practice rather than anecdote. Observed values cover the deliberately
small, synthetic feature-isolation corpus, so these maxima describe conformance
fixtures rather than real-world usage. The gap to each ceiling is the headroom §16
reserves for adversarial-input bounding rather than expressive need.

Regenerate after corpus changes:

```
pnpm stats:write
```

CI runs `pnpm stats:check` after regenerating the corpus and goldens, so stale
observed maxima fail the freshness guard.

| §16 quantity                                  |           ceiling | observed max |
| --------------------------------------------- | ----------------: | -----------: |
| container files                               |             4,096 |            8 |
| container uncompressed bytes                  |     2,147,483,648 |       33,814 |
| single manifest-listed JSON document bytes    |        67,108,864 |        4,735 |
| aggregate manifest-listed JSON document bytes |        67,108,864 |        5,109 |
| id length                                     |               128 |           27 |
| largest absolute authored number              | 1,000,000,000,000 |        3,001 |
| model capabilities                            |               128 |            3 |
| parameters                                    |            10,000 |            6 |
| nodes                                         |            10,000 |           17 |
| tree depth                                    |                64 |            4 |
| grid or warp cols/rows                        |                64 |           10 |
| total mesh and warp control points            |         1,048,576 |          130 |
| total sprite-mesh triangles                   |         2,097,152 |          200 |
| explicit mesh points per sprite               |            65,536 |            4 |
| explicit mesh triangles per sprite            |           131,072 |            2 |
| mask sources per sprite                       |               256 |            2 |
| aggregate mask references                     |           100,000 |            3 |
| bindings                                      |           100,000 |            5 |
| binding axes                                  |                 3 |            3 |
| keys per axis                                 |                33 |            4 |
| value scalars per binding                     |         1,048,576 |          100 |
| aggregate binding value scalars               |         8,388,608 |          100 |
| expressions                                   |             4,096 |            3 |
| aggregate expression entries                  |           100,000 |            3 |
| motions                                       |             4,096 |            2 |
| aggregate motion tracks                       |           100,000 |            3 |
| aggregate motion keys                         |         1,000,000 |            9 |
| atlas rect/annotation entries                 |           100,000 |            2 |
| single PNG file bytes                         |       268,435,456 |       19,742 |
| texture dimension (px)                        |             8,192 |          128 |
| single decoded texture pixels                 |        16,777,216 |       12,544 |
| aggregate decoded texture pixels              |        67,108,864 |       19,456 |
| canvas dimension (px)                         |            16,384 |          160 |
| canvas pixels                                 |         8,388,608 |       25,600 |
| physics chains                                |               256 |            2 |
| links per chain                               |                64 |            2 |
| aggregate physics inputs                      |           100,000 |            3 |
| aggregate physics outputs                     |           100,000 |            4 |
| physics fps                                   |               240 |           60 |
| variant slots                                 |             4,096 |            2 |
| aggregate variant options                     |           100,000 |            4 |
| aggregate variant node memberships            |         1,000,000 |            5 |
