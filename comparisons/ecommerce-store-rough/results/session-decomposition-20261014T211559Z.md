Dataset `dev` generator 0.5.0 · ecommerce-store 5c32151 · tier 1 signal, not results.

### fastify-postgres-redis (shared budget, quotes only)

1 trial(s), 0 with at least one contended step (those steps excluded; n = clean observations per row). Cold start to first 200: 1205 ms. Contention at start: none. Host (macOS) cores busy outside the VM, median per trial: 2.26.

| offered rps | n | achieved rps | shed | p50 ms | p99 ms | quote p99 | product p99 | product hit % | postgres cores | redis cores | app cores | target cores | target CPU ms/req | target memory MiB | disk reads MiB | uncharged VM cores | gen CPU |
|-|-|-|-|-|-|-|-|-|-|-|-|-|-|-|-|-|-|
| 400 | 1 | 399.9 | 0 | 2.5 | 4.8 | 4.8 | - | - | 0.08 | 0.03 | 0.25 | 0.37 | 0.924 | 512 | 1.3 | 0.39 | 0.07 |
| 800 | 1 | 799.9 | 0 | 2.4 | 4.5 | 4.5 | - | - | 0.13 | 0.04 | 0.36 | 0.53 | 0.665 | 514 | 0.4 | 0.46 | 0.09 |
| 1200 | 1 | 1199.7 | 0 | 2.4 | 4.5 | 4.5 | - | - | 0.19 | 0.04 | 0.44 | 0.68 | 0.569 | 522 | 1.3 | 0.54 | 0.10 |
| 1600 | 1 | 1599.7 | 0 | 2.5 | 4.7 | 4.7 | - | - | 0.24 | 0.05 | 0.50 | 0.79 | 0.491 | 521 | 0.0 | 0.57 | 0.12 |
| 2000 | 1 | 1999.6 | 0 | 2.6 | 103.0 | 103.0 | - | - | 0.28 | 0.05 | 0.54 | 0.88 | 0.441 | 521 | 0.0 | 0.55 | 0.15 (1x gen flag) |
| 2400 | 1 | 2399.6 | 0 | 2.6 | 4.8 | 4.8 | - | - | 0.31 | 0.05 | 0.57 | 0.94 | 0.392 | 514 | 0.1 | 0.59 | 0.14 |
| 3200 | 1 | 3199.3 | 0 | 2.6 | 5.3 | 5.3 | - | - | 0.37 | 0.05 | 0.65 | 1.08 | 0.338 | 514 | 0.0 | 0.62 | 0.17 |
| 4000 | 1 | 3999.3 | 0 | 2.6 | 6.0 | 6.0 | - | - | 0.42 | 0.06 | 0.71 | 1.19 | 0.297 | 514 | 0.1 | 0.65 | 0.19 |

### fastify-postgres-redis (shared budget, products only)

1 trial(s), 0 with at least one contended step (those steps excluded; n = clean observations per row). Cold start to first 200: 1094 ms. Contention at start: none. Host (macOS) cores busy outside the VM, median per trial: 2.14.

| offered rps | n | achieved rps | shed | p50 ms | p99 ms | quote p99 | product p99 | product hit % | postgres cores | redis cores | app cores | target cores | target CPU ms/req | target memory MiB | disk reads MiB | uncharged VM cores | gen CPU |
|-|-|-|-|-|-|-|-|-|-|-|-|-|-|-|-|-|-|
| 1600 | 1 | 1599.7 | 0 | 2.1 | 4.5 | - | 4.5 | 73.7 | 0.07 | 0.05 | 0.31 | 0.43 | 0.271 | 512 | 1.3 | 0.46 | 0.15 |
| 3200 | 1 | 3199.2 | 0 | 2.1 | 38.0 | - | 38.0 | 85.2 | 0.07 | 0.06 | 0.36 | 0.49 | 0.154 | 519 | 0.4 | 0.52 | 0.22 (1x gen flag) |
| 4800 | 1 | 4799.4 | 0 | 2.3 | 6.5 | - | 6.5 | 91.4 | 0.06 | 0.06 | 0.39 | 0.52 | 0.108 | 529 | 1.2 | 0.53 | 0.28 |
| 6400 | 1 | 6399.4 | 0 | 2.5 | 5.6 | - | 5.6 | 94.5 | 0.05 | 0.06 | 0.41 | 0.53 | 0.082 | 535 | 0.2 | 0.53 | 0.32 |
| 8000 | 1 | 7931.9 | 987 | 2.8 | 123.8 | - | 123.8 | 96.2 | 0.05 | 0.07 | 0.44 | 0.56 | 0.071 | 540 | 0.0 | 0.49 | 0.42 (1x gen flag) |

### harper reference (quotes only)

1 trial(s), 0 with at least one contended step (those steps excluded; n = clean observations per row). Cold start to first 200: 1998 ms. Contention at start: none. Host (macOS) cores busy outside the VM, median per trial: 1.98.

| offered rps | n | achieved rps | shed | p50 ms | p99 ms | quote p99 | product p99 | product hit % | harper cores | target cores | target CPU ms/req | target memory MiB | disk reads MiB | uncharged VM cores | gen CPU |
|-|-|-|-|-|-|-|-|-|-|-|-|-|-|-|-|
| 400 | 1 | 400.0 | 0 | 2.8 | 18.0 | 18.0 | - | - | 0.57 | 0.58 | 1.448 | 545 | 0.0 | 0.12 | 0.06 |
| 800 | 1 | 799.8 | 0 | 2.8 | 9.1 | 9.1 | - | - | 0.81 | 0.81 | 1.014 | 572 | 0.0 | 0.13 | 0.07 |
| 1200 | 1 | 1199.8 | 0 | 3.2 | 55.9 | 55.9 | - | - | 0.99 (thr 0.1s) | 1.00 | 0.831 | 575 | 0.0 | 0.12 | 0.08 |
| 1600 | 1 | 1599.5 | 0 | 3.8 | 18.6 | 18.6 | - | - | 1.26 | 1.27 | 0.795 | 576 | 0.0 | 0.12 | 0.09 |
| 2000 | 1 | 1999.3 | 0 | 5.9 | 165.7 | 165.7 | - | - | 1.59 (thr 0.8s) | 1.60 | 0.801 | 577 | 0.0 | 0.12 | 0.12 |
| 2400 | 1 | 2351.6 | 288 | 210.1 | 373.4 | 373.4 | - | - | 1.99 (thr 2.9s) | 2.00 | 0.850 | 582 | 0.0 | 0.10 | 0.19 |
| 3200 | 1 | 2354.5 | 11926 | 309.6 | 476.3 | 476.3 | - | - | 1.99 (thr 3.0s) | 2.00 | 0.846 | 583 | 0.0 | 0.08 | 0.21 |
| 4000 | 1 | 2354.6 | 23929 | 314.2 | 382.3 | 382.3 | - | - | 1.99 (thr 3.2s) | 2.00 | 0.849 | 560 | 0.0 | 0.09 | 0.21 |

### harper reference (products only)

1 trial(s), 0 with at least one contended step (those steps excluded; n = clean observations per row). Cold start to first 200: 2022 ms. Contention at start: none. Host (macOS) cores busy outside the VM, median per trial: 2.2.

| offered rps | n | achieved rps | shed | p50 ms | p99 ms | quote p99 | product p99 | product hit % | harper cores | target cores | target CPU ms/req | target memory MiB | disk reads MiB | uncharged VM cores | gen CPU |
|-|-|-|-|-|-|-|-|-|-|-|-|-|-|-|-|
| 1600 | 1 | 1599.7 | 0 | 2.3 | 4.7 | - | 4.7 | 73.7 | 0.58 | 0.59 | 0.368 | 602 | 0.0 | 0.25 | 0.14 |
| 3200 | 1 | 3199.3 | 0 | 2.5 | 10.9 | - | 10.9 | 85.2 | 0.73 (thr 0.2s) | 0.73 | 0.230 | 650 | 0.1 | 0.26 | 0.20 |
| 4800 | 1 | 4684.6 | 1720 | 2.6 | 307.1 | - | 307.1 | 91.4 | 0.93 (thr 1.0s) | 0.94 | 0.201 | 708 | 0.0 | 0.28 | 0.28 |
| 6400 | 1 | 6359.4 | 588 | 2.5 | 103.2 | - | 103.2 | 94.4 | 0.90 (thr 0.7s) | 0.91 | 0.143 | 739 | 0.0 | 0.26 | 0.30 |
| 8000 | 1 | 7950.2 | 721 | 2.6 | 60.6 | - | 60.6 | 96.2 | 0.95 (thr 0.5s) | 0.96 | 0.120 | 779 | 0.0 | 0.26 | 0.33 |

