Dataset `dev` generator 0.5.0 · ecommerce-store 5c32151 · tier 1 signal, not results.

### harper reference (no page-cache drop)

1 trial(s), 0 with at least one contended step (those steps excluded; n = clean observations per row). Cold start to first 200: 1587 ms. Contention at start: none. Host (macOS) cores busy outside the VM, median per trial: 2.56.

| offered rps | n | achieved rps | shed | p50 ms | p99 ms | quote p99 | product p99 | product hit % | harper cores | target cores | target CPU ms/req | target memory MiB | disk reads MiB | uncharged VM cores | gen CPU |
|-|-|-|-|-|-|-|-|-|-|-|-|-|-|-|-|
| 400 | 1 | 400.0 | 0 | 2.7 | 93.8 | 140.8 | 71.4 | 37.3 | 0.64 (thr 0.1s) | 0.64 | 1.606 | 395 | 0.0 | 0.12 | 0.09 (1x gen flag) |
| 800 | 1 | 799.8 | 0 | 2.5 | 49.2 | 72.6 | 24.9 | 49.4 | 0.74 (thr 0.5s) | 0.75 | 0.942 | 445 | 0.0 | 0.10 | 0.09 |
| 1600 | 1 | 1599.7 | 0 | 2.5 | 51.7 | 63.5 | 32.8 | 64.1 | 1.10 (thr 0.1s) | 1.12 | 0.698 | 473 | 0.0 | 0.11 | 0.11 |
| 2400 | 1 | 2399.1 | 0 | 2.6 | 154.1 | 171.2 | 146.1 | 73.7 | 1.34 (thr 0.7s) | 1.35 | 0.565 | 498 | 0.0 | 0.12 | 0.13 |

### harper reference (writes off)

1 trial(s), 0 with at least one contended step (those steps excluded; n = clean observations per row). Cold start to first 200: 2141 ms. Contention at start: none. Host (macOS) cores busy outside the VM, median per trial: 2.35.

| offered rps | n | achieved rps | shed | p50 ms | p99 ms | quote p99 | product p99 | product hit % | harper cores | target cores | target CPU ms/req | target memory MiB | disk reads MiB | uncharged VM cores | gen CPU |
|-|-|-|-|-|-|-|-|-|-|-|-|-|-|-|-|
| 400 | 1 | 400.0 | 0 | 2.4 | 6.5 | 7.9 | 4.2 | 50.9 | 0.46 | 0.47 | 1.173 | 560 | 0.0 | 0.13 | 0.07 |
| 800 | 1 | 799.9 | 0 | 2.2 | 6.2 | 7.8 | 3.7 | 62.0 | 0.64 | 0.65 | 0.811 | 590 | 0.0 | 0.11 | 0.07 |
| 1600 | 1 | 1599.7 | 0 | 2.3 | 31.5 | 48.8 | 12.4 | 73.5 | 0.92 | 0.94 | 0.585 | 608 | 0.0 | 0.09 | 0.10 |
| 2400 | 1 | 2399.6 | 0 | 2.4 | 61.4 | 77.4 | 54.1 | 81.6 | 1.23 (thr 0.4s) | 1.24 | 0.519 | 634 | 0.0 | 0.12 | 0.14 |

### fastify-postgres-redis (shared budget, no page-cache drop)

1 trial(s), 0 with at least one contended step (those steps excluded; n = clean observations per row). Cold start to first 200: 954 ms. Contention at start: none. Host (macOS) cores busy outside the VM, median per trial: 3.79.

| offered rps | n | achieved rps | shed | p50 ms | p99 ms | quote p99 | product p99 | product hit % | postgres cores | redis cores | app cores | target cores | target CPU ms/req | target memory MiB | disk reads MiB | uncharged VM cores | gen CPU |
|-|-|-|-|-|-|-|-|-|-|-|-|-|-|-|-|-|-|
| 400 | 1 | 400.0 | 0 | 2.4 | 8.7 | 13.3 | 8.4 | 37.3 | 0.09 | 0.04 | 0.25 | 0.38 | 0.937 | 389 | 0.0 | 0.33 | 0.08 |
| 800 | 1 | 799.9 | 0 | 2.2 | 4.8 | 5.0 | 4.4 | 49.3 | 0.11 | 0.04 | 0.33 | 0.48 | 0.602 | 393 | 0.0 | 0.42 | 0.10 |
| 1600 | 1 | 1599.8 | 0 | 2.2 | 4.4 | 4.6 | 4.1 | 64.1 | 0.16 | 0.06 | 0.43 | 0.66 | 0.410 | 401 | 0.0 | 0.53 | 0.13 |
| 2400 | 1 | 2399.6 | 0 | 2.2 | 4.3 | 4.5 | 4.1 | 73.7 | 0.21 | 0.06 | 0.51 | 0.78 | 0.326 | 405 | 0.0 | 0.59 | 0.15 |

### fastify-postgres-redis (shared budget, writes off)

1 trial(s), 0 with at least one contended step (those steps excluded; n = clean observations per row). Cold start to first 200: 1172 ms. Contention at start: none. Host (macOS) cores busy outside the VM, median per trial: 3.59.

| offered rps | n | achieved rps | shed | p50 ms | p99 ms | quote p99 | product p99 | product hit % | postgres cores | redis cores | app cores | target cores | target CPU ms/req | target memory MiB | disk reads MiB | uncharged VM cores | gen CPU |
|-|-|-|-|-|-|-|-|-|-|-|-|-|-|-|-|-|-|
| 400 | 1 | 400.0 | 0 | 2.4 | 11.2 | 12.7 | 8.9 | 50.9 | 0.06 | 0.04 | 0.25 | 0.35 | 0.868 | 501 | 0.8 | 0.35 | 0.08 |
| 800 | 1 | 799.9 | 0 | 2.2 | 4.5 | 4.7 | 4.2 | 62.0 | 0.09 | 0.04 | 0.32 | 0.45 | 0.563 | 504 | 0.0 | 0.42 | 0.09 |
| 1600 | 1 | 1599.8 | 0 | 2.2 | 4.7 | 5.0 | 4.2 | 73.5 | 0.14 | 0.05 | 0.43 | 0.64 | 0.397 | 512 | 0.8 | 0.52 | 0.12 |
| 2400 | 1 | 2399.7 | 0 | 2.4 | 5.2 | 5.5 | 4.7 | 81.6 | 0.20 | 0.06 | 0.52 | 0.78 | 0.325 | 519 | 0.0 | 0.56 | 0.16 |

