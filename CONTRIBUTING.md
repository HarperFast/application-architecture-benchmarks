# Contributing

This repo follows Harper's [organization contribution guidelines](https://github.com/HarperFast/.github/blob/main/CONTRIBUTING.md) and [Code of Conduct](https://github.com/HarperFast/.github/blob/main/CODE_OF_CONDUCT.md).

Read [`README.md`](README.md) first. It defines the application specification, the measurement rules, how implementations are built, and how results may be described. Contributions are evaluated against it, and its Reporting results section covers submitting an implementation and challenging a published result.

## Especially welcome

If you maintain or work on one of the technologies measured here, and you think we configured it badly, built it against outdated guidance, or left performance on the table, please tell us. A pull request improving a competing implementation is the most useful thing anyone can send this project.

## Before you start

Open an issue, or say hello in [Discord](https://harper.fast/discord), before large changes. This matters most for a whole new stack, where scope and conformance are worth agreeing on up front.

A change to the specification, the dataset, or the measurement rules affects every result produced under them, so expect more discussion and slower merges than a change to a single implementation.

## After a merge

Benchmarks are not re-run per pull request. A merged change is picked up by the next comparison run. Already published results stay frozen as dated snapshots; where a change invalidates one, that is handled as a challenge rather than by editing the snapshot.
