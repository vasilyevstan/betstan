# Message Flows

## Messaging model

BetStan combines browser HTTP, Server-Sent Events, and RabbitMQ fanout events.
RabbitMQ topics represent domain facts, while each consumer owns its queue and
database updates.

For step-by-step product behavior around these exchanges, including user
sessions and odds calculation, see [[Application Processes]].

| Domain fact | Topic | Main publisher | Main consumers |
|---|---|---|---|
| Odds selected | `event:odds:selected` | Event | Slip |
| Slip submitted | `slip:bet` | Slip | Moderation, Resulting, Bet |
| Moderation completed | `moderation:result` | Moderation | Slip, Resulting, Bet |
| Event created | `event:new` | Event or Backoffice | Event, Gamemaster, Backoffice |
| Event result available | `backoffice:event:result` | Gamemaster or Backoffice | Event, Resulting, Moderation, Backoffice, Gamemaster |
| Visibility changed | `backoffice:event:visibility` | Backoffice | Event |
| Live state advanced | `gamemaster:event:live` | Gamemaster | Event, Moderation, Resulting |
| Bet row settled | `resulting:sliprow:settle` | Resulting | Bet |
| Bet settled | `resulting:slip:settle` | Resulting | Bet |

The topic names are stable contracts. Consumer queue names and runtime
instances are implementation details and may evolve independently.

## Event creation and publication

Events can originate from the scheduler or the public Backoffice.

```mermaid
sequenceDiagram
    autonumber
    actor Operator as Visitor or operator
    participant BO as Backoffice
    participant DB as Backoffice database
    participant MQ as RabbitMQ
    participant Event as Event service
    participant GM as Gamemaster

    Operator->>BO: Create event command
    BO->>DB: Persist event and publication pending marker
    BO->>MQ: Publish event:new with confirmation
    MQ-->>BO: Delivery confirmed
    BO->>DB: Clear pending marker

    par Fanout
        MQ->>Event: Project public event
        MQ->>GM: Register simulation
        MQ->>BO: Reconcile local event state
    end

    opt Broker unavailable or process restarts
        BO->>DB: Read pending publication
        BO->>MQ: Replay the same event:new fact
    end
```

The stable creation request identifier makes an ambiguous client retry
idempotent. A reused identifier with different event content is a conflict,
not a second event.

## Selecting odds and building a board

```mermaid
sequenceDiagram
    autonumber
    actor Player
    participant Event as Event API
    participant MQ as RabbitMQ
    participant Slip as Slip service
    participant DB as Slip database

    Player->>Event: Select an odds option
    Event->>Event: Validate event, market, selection, phase, and quote
    Event->>MQ: Publish event:odds:selected
    MQ->>Slip: Deliver selected odds
    Slip->>DB: Upsert the matching LIVE or PRE_MATCH draft
    Player->>Slip: Read both boards
    Slip-->>Player: PRE_MATCH board and LIVE board
```

Anonymous users can browse events. A user identity is required to persist and
submit a personal betting board.

## Wager placement and moderation

```mermaid
sequenceDiagram
    autonumber
    actor Player
    participant Slip as Slip service
    participant SlipDB as Slip database
    participant MQ as RabbitMQ
    participant Mod as Moderation
    participant Bet as Bet service
    participant Result as Resulting

    Player->>Slip: Submit wager and board confirmation
    Slip->>SlipDB: Compare revision, fingerprint, and placement attempt
    Slip->>SlipDB: Persist PENDING slip and publication state
    Slip->>MQ: Publish slip:bet with confirmation

    par Create downstream state
        MQ->>Mod: Validate current authority
        MQ->>Bet: Create user-visible bet
        MQ->>Result: Register settlement input
    end

    Mod->>Mod: Check bet kind, event phase, market status, quote version, and expiry
    Mod->>MQ: Publish moderation:result

    par Apply verdict
        MQ->>Slip: Update submitted slip status
        MQ->>Bet: Update bet status
        MQ->>Result: Release or reject settlement work
    end
```

Important invariants:

- a single submission contains only live or only pre-match rows;
- a placement attempt is idempotent;
- a changed payload cannot reuse the same attempt as a silent retry;
- moderation uses authoritative current and historical quote state, not the
  browser label;
- early or duplicated messages are parked or ignored safely.

## Live match updates and settlement

```mermaid
sequenceDiagram
    autonumber
    participant GM as Gamemaster
    participant MQ as RabbitMQ
    participant Projection as Event projection
    participant SSE as Event SSE hub
    actor Browser
    participant Mod as Moderation
    participant Result as Resulting
    participant Bet as Bet service

    GM->>GM: Advance deterministic match state
    GM->>MQ: Publish gamemaster:event:live

    par Live fanout
        MQ->>Projection: Persist public read model
        MQ->>SSE: Deliver low-latency update
        SSE-->>Browser: SSE live update
        MQ->>Mod: Refresh betting authority
        MQ->>Result: Apply market settlements
    end

    opt A market settles
        Result->>MQ: Publish resulting:sliprow:settle
        MQ->>Bet: Record row outcome
        GM->>GM: Rotate the next eligible incident market
    end

    opt All rows are terminal
        Result->>MQ: Publish resulting:slip:settle
        MQ->>Bet: Record final result and payout
    end

    opt Full-time
        GM->>GM: Settle Second Half Score from final minus half-time score
        GM->>MQ: Publish backoffice:event:result
        MQ->>Projection: Mark event resulted
        MQ->>Result: Settle pre-match products
    end
```

The browser stream is intentionally recoverable. Sequence checks reject stale
updates, and terminal state is reconciled against the REST projection so a
missed or reordered stream message does not become final truth.

At most six non-terminal live products are projected into the actionable UI.
The authoritative snapshot retains closed and settled versions so Moderation
can validate an accepted historical quote and Resulting can replay settlement
idempotently. Exact-score products are resolved by selection ID; their shared
neutral side is display metadata, not sufficient settlement identity.

## Visibility and manual result flow

```mermaid
sequenceDiagram
    autonumber
    actor Operator
    participant BO as Backoffice
    participant DB as Backoffice database
    participant MQ as RabbitMQ
    participant Event as Event service
    participant Result as Resulting

    alt Visibility command
        Operator->>BO: Set ONLINE or OFFLINE
        BO->>DB: Persist target and pending publication
        BO->>MQ: Publish backoffice:event:visibility
        MQ->>Event: Apply visibility atomically
    else Manual result command
        Operator->>BO: Set final score
        BO->>DB: Persist one terminal result
        BO->>MQ: Publish backoffice:event:result
        par Result fanout
            MQ->>Event: Update public result
            MQ->>Result: Settle affected bets
        end
    end
```

An identical result retry is accepted idempotently. A conflicting second final
score is rejected.

## Delivery and ordering rules

- Publishers confirm broker acceptance for critical mutations.
- A database pending marker remains until confirmation and is replayed after
  restart.
- Consumers acknowledge only after their durable state transition succeeds.
- Duplicate delivery is expected and must be harmless.
- Monotonic sequence, version, and terminal-state guards reject stale updates.
- Out-of-order moderation or settlement is parked until its parent bet exists.
- Message payloads remain backward compatible across a rolling deployment.

## Related pages

- [[Architecture]]
- [[Live Betting Production]]
- [[Security]]
- [[Engineering Learnings]]
