### fastify-postgres-redis (shared budget, quotes only)

1 trial(s), 0 with at least one contended step (those steps excluded; n = clean observations per row). Cold start to first 200: 843 ms. Contention at start: none. Host (macOS) cores busy outside the VM, mean per trial: 1.4.

| offered rps | n | achieved rps | shed | p50 ms | p99 ms | quote p99 | product p99 | product hit % | postgres cores | redis cores | app cores | target cores | target CPU ms/req | uncharged VM cores | gen CPU |
|-|-|-|-|-|-|-|-|-|-|-|-|-|-|-|-|
| 400 | 1 | 400.0 | 0 | 2.7 | 5.7 | 5.7 | - | - | 0.08 | 0.03 | 0.26 | 0.38 | 0.958 | 0.37 | 0.07 |
| 800 | 1 | 799.9 | 0 | 2.4 | 4.8 | 4.8 | - | - | 0.14 | 0.04 | 0.36 | 0.54 | 0.671 | 0.46 | 0.09 |
| 1200 | 1 | 1199.8 | 0 | 2.4 | 4.5 | 4.5 | - | - | 0.18 | 0.04 | 0.41 | 0.65 | 0.540 | 0.54 | 0.10 |
| 1600 | 1 | 1599.7 | 0 | 2.5 | 4.5 | 4.5 | - | - | 0.23 | 0.05 | 0.46 | 0.74 | 0.462 | 0.57 | 0.12 |
| 2000 | 1 | 1999.6 | 0 | 2.5 | 4.5 | 4.5 | - | - | 0.27 | 0.05 | 0.50 | 0.82 | 0.410 | 0.57 | 0.13 |
| 2400 | 1 | 2399.3 | 0 | 3.0 | 6.1 | 6.1 | - | - | 0.31 | 0.05 | 0.54 | 0.90 | 0.377 | 0.56 | 0.15 |
| 3200 | 1 | 3199.4 | 0 | 3.1 | 6.1 | 6.1 | - | - | 0.36 | 0.05 | 0.59 | 1.01 | 0.316 | 0.56 | 0.17 |
| 4000 | 1 | 3999.2 | 0 | 2.7 | 19.0 | 19.0 | - | - | 0.41 | 0.06 | 0.68 | 1.15 | 0.287 | 0.63 | 0.20 |

### fastify-postgres-redis (shared budget, products only)

1 trial(s), 0 with at least one contended step (those steps excluded; n = clean observations per row). Cold start to first 200: 1115 ms. Contention at start: none. Host (macOS) cores busy outside the VM, mean per trial: 2.29.

| offered rps | n | achieved rps | shed | p50 ms | p99 ms | quote p99 | product p99 | product hit % | postgres cores | redis cores | app cores | target cores | target CPU ms/req | uncharged VM cores | gen CPU |
|-|-|-|-|-|-|-|-|-|-|-|-|-|-|-|-|
| 1600 | 1 | 1594.7 | 0 | 2.0 | 5.1 | - | 5.1 | 74.4 | 0.07 | 0.05 | 0.33 | 0.46 | 0.291 | 0.41 | 0.17 |
| 3200 | 1 | 3199.4 | 0 | 2.0 | 5.0 | - | 5.0 | 85.3 | 0.08 | 0.06 | 0.39 | 0.54 | 0.167 | 0.43 | 0.24 |
| 4800 | 1 | 4736.1 | 263 | 2.3 | 180.5 | - | 180.5 | 90.8 | 0.10 | 0.08 | 0.53 | 0.71 | 0.153 | 0.47 | 0.37 (1x gen flag) |
| 6400 | 1 | 6398.8 | 0 | 2.2 | 6.9 | - | 6.9 | 94.1 | 0.06 | 0.07 | 0.42 | 0.55 | 0.086 | 0.51 | 0.37 |
| 8000 | 1 | 7798.2 | 3002 | 2.3 | 92.8 | - | 92.8 | 95.8 | 0.06 | 0.08 | 0.52 | 0.66 | 0.084 | 0.50 | 0.46 (1x gen flag) |

### harper reference (quotes only)

1 trial(s), 0 with at least one contended step (those steps excluded; n = clean observations per row). Cold start to first 200: 2064 ms. Contention at start: none. Host (macOS) cores busy outside the VM, mean per trial: 2.

| offered rps | n | achieved rps | shed | p50 ms | p99 ms | quote p99 | product p99 | product hit % | harper cores | target cores | target CPU ms/req | uncharged VM cores | gen CPU |
|-|-|-|-|-|-|-|-|-|-|-|-|-|-|
| 400 | 1 | 400.0 | 0 | 2.6 | 8.6 | 8.6 | - | - | 0.54 | 0.55 | 1.370 | 0.12 | 0.07 |
| 800 | 1 | 800.0 | 0 | 2.9 | 104.9 | 104.9 | - | - | 0.83 (thr 0.6s) | 0.84 | 1.052 | 0.10 | 0.09 |
| 1200 | 1 | 1199.6 | 0 | 3.3 | 75.4 | 75.4 | - | - | 1.04 (thr 0.1s) | 1.06 | 0.882 | 0.11 | 0.09 |
| 1600 | 1 | 1599.8 | 0 | 4.2 | 100.7 | 100.7 | - | - | 1.32 (thr 0.4s) | 1.33 | 0.830 | 0.13 | 0.11 |
| 2000 | 1 | 1948.2 | 113 | 7.0 | 413.6 | 413.6 | - | - | 1.64 (thr 1.1s) | 1.65 | 0.841 | 0.14 | 0.15 |
| 2400 | 1 | 2358.9 | 183 | 124.7 | 332.6 | 332.6 | - | - | 1.93 (thr 2.4s) | 1.94 | 0.820 | 0.13 | 0.19 |
| 3200 | 1 | 2387.5 | 11441 | 298.4 | 455.6 | 455.6 | - | - | 1.99 (thr 3.2s) | 2.00 | 0.834 | 0.12 | 0.26 (1x gen flag) |
| 4000 | 1 | 2541.4 | 21131 | 285.2 | 511.8 | 511.8 | - | - | 2.00 (thr 3.2s) | 2.00 | 0.788 | 0.12 | 0.24 |

### harper reference (products only)

1 trial(s), 0 with at least one contended step (those steps excluded; n = clean observations per row). Cold start to first 200: 1817 ms. Contention at start: none. Host (macOS) cores busy outside the VM, mean per trial: 2.09.

| offered rps | n | achieved rps | shed | p50 ms | p99 ms | quote p99 | product p99 | product hit % | harper cores | target cores | target CPU ms/req | uncharged VM cores | gen CPU |
|-|-|-|-|-|-|-|-|-|-|-|-|-|-|
| 1600 | 1 | 1599.8 | 0 | 2.3 | 5.9 | - | 5.9 | 74.6 | 0.61 | 0.61 | 0.383 | 0.21 | 0.15 |
| 3200 | 1 | 3199.4 | 0 | 2.4 | 95.6 | - | 95.6 | 85.5 | 0.85 (thr 0.1s) | 0.85 | 0.267 | 0.21 | 0.26 (1x gen flag) |
| 4800 | 1 | 4799.0 | 0 | 2.4 | 80.8 | - | 80.8 | 91.1 | 0.96 (thr 0.6s) | 0.97 | 0.202 | 0.24 | 0.29 (1x gen flag) |
| 6400 | 1 | 6370.5 | 421 | 2.3 | 86.3 | - | 86.3 | 94.3 | 0.92 (thr 0.3s) | 0.92 | 0.144 | 0.24 | 0.31 |
| 8000 | 1 | 7648.4 | 5251 | 2.5 | 303.9 | - | 303.9 | 95.9 | 1.14 (thr 0.8s) | 1.14 | 0.150 | 0.24 | 0.46 (1x gen flag) |

