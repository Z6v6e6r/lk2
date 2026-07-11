# ADR 0001: Modular monolith with separate runtime processes

- Status: accepted
- Date: 2026-07-11

## Context

PadlHub needs one domain model for web, mobile and CUP while gradually replacing Viva. The expected initial scale and team do not justify independently deployed domain microservices or Kubernetes.

## Decision

Use a TypeScript monorepo and modular monolith. Run API, background worker and realtime gateway as separate stateless processes over shared packages and PostgreSQL domain schemas. Use RabbitMQ for asynchronous boundaries.

## Consequences

Domain ownership and package boundaries must be enforced in reviews. A module may later become a service without changing client contracts. Operational complexity remains compatible with two Compose-based production app nodes.
