# Karobakbak — Running Ads & Monetization Plan

## 1. Purpose

This document defines when and how Karobakbak should activate advertising, how to experiment safely, how to evaluate monetization, and how to avoid sacrificing product quality for short-term ad revenue.

The goal is not to maximize advertising revenue immediately.

The goal is to reach a point where:

> Karobakbak can fund its own operating costs while maintaining a good user experience.

---

# 2. Monetization Philosophy

Karobakbak should progress through three economic stages:

```text
HOBBY
Revenue < Cost

        ↓

SELF-SUSTAINING
Revenue ≈ Cost

        ↓

BUSINESS
Revenue > Cost with meaningful surplus
```

The first milestone is self-sustainability, not profit maximization.

---

# 3. Define the Personal Hobby Budget

Before launch, set a maximum monthly subsidy.

Example:

```text
Maximum personal subsidy = ₹10,000/month
```

This is a project constraint, not a product metric.

If:

```text
Operating cost = ₹7,000
Revenue = ₹1,000
```

then:

```text
Personal subsidy = ₹6,000
```

If the subsidy exceeds the predetermined threshold for a sustained period, reassess the project.

This prevents infrastructure and service costs from growing unnoticed.

---

# 4. Do Not Monetize Too Early

Initial priority:

1. Product stability.
2. Matchmaking reliability.
3. Good chat UX.
4. Safety.
5. Retention.
6. Organic usage.
7. Monetization.

A website with no users cannot generate meaningful advertising revenue.

A website with users who immediately leave is also not ready for aggressive monetization.

---

# 5. Launch Stages

## Stage 0 — Development

Target:

```text
0 users
```

Ads:

```text
OFF
```

Use:

- no-op ad provider;
- house ads;
- fake ad slots for UI testing.

Goal:

Verify that the application works without advertising dependencies.

---

## Stage 1 — Private Testing

Target:

```text
friends / invited testers
```

Ads:

```text
OFF
```

Measure:

- match success;
- message delivery;
- session duration;
- crashes;
- reports;
- abuse;
- retention.

Do not optimize revenue yet.

---

## Stage 2 — Early Public Launch

Indicative target:

```text
100–500 MAU
```

Ads:

```text
OFF or extremely limited experiment
```

Focus on:

- product-market signal;
- retention;
- safety;
- infrastructure costs.

---

## Stage 3 — Monetization Experiment

Indicative target:

```text
500–2,000 MAU
```

Introduce one unobtrusive ad placement.

Recommended first placement:

```text
matchmaking / waiting screen
```

Do not launch multiple ad formats simultaneously.

---

## Stage 4 — Early Monetization

Indicative target:

```text
2,000–10,000 MAU
```

If the first experiment is healthy:

- improve fill rate;
- test frequency;
- add one additional placement;
- monitor retention;
- measure revenue/user.

---

## Stage 5 — Sustainable Operation

Target:

```text
Revenue ≥ operating costs
for at least 3 consecutive months
```

At this point Karobakbak has achieved the primary financial objective:

> The service pays for itself.

Only after this should significant additional infrastructure spending be justified by expected additional revenue or product value.

---

# 6. Metrics to Collect Before Running Ads

The following metrics should exist before monetization experiments:

### User

```text
DAU
WAU
MAU
new_users
returning_users
```

### Chat

```text
sessions
matches
messages
conversation_duration
matches_per_session
next_clicks
```

### Retention

```text
D1
D7
D30
```

### Safety

```text
reports
blocks
moderation_actions
abuse_rate
```

### Infrastructure

```text
active_connections
messages_per_second
Redis operations
database writes
storage volume
CPU
RAM
network traffic
```

Without these measurements, it is difficult to determine whether ads are helping or hurting the business.

---

# 7. Economic Model

Core equation:

```text
Monthly Profit =
Advertising Revenue
+ Premium Revenue
+ Sponsorship Revenue
- Infrastructure
- Storage
- Moderation
- Third-party services
- Payment fees
- Other operating costs
```

Initially:

```text
Premium Revenue = 0
Sponsorship Revenue = 0
```

so:

```text
Monthly Profit =
Advertising Revenue - Operating Costs
```

---

# 8. Per-User Economics

Calculate:

```text
ARPU =
Monthly Revenue / MAU
```

and:

```text
Cost Per Active User =
Variable Monthly Cost / MAU
```

Then:

```text
Contribution Margin Per User =
ARPU - Variable Cost Per User
```

The desired condition is:

```text
Contribution Margin > 0
```

---

# 9. Marginal Economics

This is more important than total traffic.

Suppose:

```text
10,000 MAU
Revenue = ₹20,000
Cost = ₹8,000
```

The system is healthy.

Now grow:

```text
50,000 MAU
Revenue = ₹100,000
Cost = ₹25,000
```

Even better.

But if:

```text
50,000 MAU
Revenue = ₹40,000
Cost = ₹80,000
```

growth makes the business worse.

Therefore:

> Never optimize for user count without measuring the economic contribution of additional users.

---

# 10. Conversation-Level Economics

Random chat users have highly variable usage.

One user might chat for 2 minutes.

Another might stay for 2 hours.

Therefore track:

```text
Revenue / conversation minute
Cost / conversation minute
```

Also track:

```text
Revenue / session
Cost / session
```

This allows the platform to understand whether highly engaged users are economically sustainable.

---

# 11. Ad Experiment Design

Start with:

```text
Control Group
No ad

Treatment Group
One matchmaking advertisement
```

Measure:

- session duration;
- messages/session;
- matches/session;
- Next usage;
- return rate;
- report rate;
- revenue.

Do not optimize solely for:

```text
impressions
```

The winning configuration is the one with the best overall economic outcome without unacceptable UX degradation.

---

# 12. Recommended First Experiment

Use one placement:

```text
Matchmaking / waiting screen
```

Initial conceptual flow:

```text
Conversation
    ↓
Next
    ↓
Matchmaking
    ↓
Ad opportunity
    ↓
New match
```

Use a frequency cap.

Example starting configuration:

```yaml
ads:
  enabled: true

  frequency:
    minimumSecondsBetweenAds: 240
    minimumConversationsBetweenAds: 2
    maximumAdsPerSession: 5
```

These are experiment values, not permanent product requirements.

---

# 13. Gradual Rollout

Do not immediately show ads to 100% of users.

Example:

```text
5%
 ↓
10%
 ↓
25%
 ↓
50%
 ↓
100%
```

At each stage compare against the control group.

Stop or roll back if:

- retention drops materially;
- session length drops materially;
- match abandonment rises;
- user complaints increase;
- safety/reporting behavior worsens;
- the revenue gain is insignificant.

---

# 14. Revenue Dashboard

Create a dashboard containing:

```text
MONTHLY ECONOMICS

MAU
DAU

Ad impressions
Ad revenue

Infrastructure
Storage
Moderation
Other services

Total operating cost

Net operating result

Revenue / MAU
Cost / MAU

Break-even MAU
Current MAU
Safety margin
```

Example:

```text
MAU                         8,420
Ad revenue                 ₹14,200

Infrastructure             ₹6,800
Storage                      ₹850
Moderation                  ₹1,200
Other                         ₹500
                           -------
Total cost                 ₹9,350

Net                        ₹4,850

Break-even MAU             ~5,600
Current MAU                8,420
```

Numbers above are illustrative.

---

# 15. Break-Even Calculation

If:

```text
Monthly fixed costs = F
Variable cost per user = C
Revenue per user = R
```

then:

```text
Break-even users =
F / (R - C)
```

If there are no meaningful variable costs:

```text
Break-even users ≈
Monthly operating cost / Revenue per active user
```

Use actual measured revenue rather than generic industry assumptions.

---

# 16. Break-Even Safety Margin

Do not target:

```text
Revenue = Cost
```

Target:

```text
Revenue > Cost × 1.25
```

or another internally selected buffer.

Why?

Because:

- ad revenue fluctuates;
- traffic fluctuates;
- cloud costs fluctuate;
- provider pricing can change;
- abuse traffic can create unexpected costs;
- moderation workload can increase.

A margin provides breathing room.

---

# 17. Three Financial States

## RED

```text
Revenue < 50% of operating cost
```

Action:

- investigate;
- reduce unnecessary infrastructure;
- review ad placement;
- review product retention;
- avoid adding expensive infrastructure.

## YELLOW

```text
Revenue covers 50–100% of operating cost
```

Action:

- continue experiments;
- improve efficiency;
- avoid aggressive spending.

## GREEN

```text
Revenue > operating cost
for 3 consecutive months
```

Action:

- classify the platform as self-sustaining;
- maintain a financial reserve;
- only then consider deliberate expansion.

---

# 18. Infrastructure Spending Rules

Do not scale infrastructure simply because traffic increased.

Scale when:

```text
capacity requires it
OR
revenue comfortably supports it
OR
reliability requires it
```

For example:

```text
Traffic doubles
    ↓
Check CPU/RAM/connections/Redis/DB
    ↓
Determine actual bottleneck
    ↓
Scale only affected component
```

Avoid premature:

- multi-region;
- oversized database;
- enterprise Redis;
- expensive observability SaaS;
- unnecessary managed services.

---

# 19. Cost Categories

Track separately:

### Infrastructure

- compute;
- load balancer;
- Redis;
- PostgreSQL;
- object storage;
- backups;
- bandwidth.

### Security

- WAF;
- DDoS protection;
- security tooling.

### Moderation

- classification APIs;
- moderation tools;
- human review.

### Analytics

- event storage;
- dashboards;
- analytics vendors.

### Business

- domain;
- email;
- payment processing;
- legal/compliance;
- support.

This makes it obvious where money is going.

---

# 20. Advertising Revenue Should Not Fund Unsafe Growth

If an increase in users creates:

```text
more reports
+
more moderation
+
more abuse
+
more infrastructure
```

but advertising revenue grows more slowly, do not blindly pursue traffic.

The objective is:

```text
healthy users
+
healthy engagement
+
healthy economics
```

not maximum user count.

---

# 21. Premium as a Second Monetization Layer

Once the platform has meaningful engagement, consider:

```text
Free:
Ads

Premium:
No ads
```

Potential additional non-abusive premium features can be evaluated later.

This creates two monetization paths:

```text
casual users
    ↓
advertising

highly engaged users
    ↓
subscription
```

Do not implement premium merely because it exists in this plan.

First establish whether users value the product.

---

# 22. Sponsorships

At meaningful scale, direct sponsorships can complement ad networks.

Examples:

- branded matchmaking screen;
- sponsored waiting-screen placement;
- launch campaigns;
- technology/product sponsorships.

These should still follow the same rule:

> Sponsorship must not interfere with conversation or safety.

---

# 23. Owner Time

Cash profit is not the same as economic profit.

Track:

```text
monthly operating cost
monthly revenue
owner hours
```

Example:

```text
Revenue: ₹30,000
Cash expenses: ₹15,000
Cash surplus: ₹15,000

Owner time: 40 hours/month
```

This is very different from:

```text
Revenue: ₹30,000
Cash expenses: ₹15,000
Owner time: 2 hours/month
```

For a hobby project, owner time can be intentionally ignored.

For a business decision, track it.

---

# 24. Monthly Review

At the end of every month record:

```text
Users
Sessions
Messages
Conversation minutes

Revenue
Infrastructure
Storage
Moderation
Other costs

Net result

D1 / D7 / D30 retention

Reports / safety events

Owner hours
```

Then answer:

1. Did usage grow?
2. Did revenue grow?
3. Did cost grow faster than revenue?
4. Did advertising hurt retention?
5. Did safety workload increase?
6. Is the platform closer to self-sustainability?
7. Should infrastructure be increased or reduced?

---

# 25. Three-Month Sustainability Test

Do not declare the platform self-sustaining after one unusually good month.

Require:

```text
Month 1: Revenue ≥ Cost
Month 2: Revenue ≥ Cost
Month 3: Revenue ≥ Cost
```

Preferably with a buffer.

For example:

```text
Revenue ≥ 1.25 × operating cost
```

for three months.

This demonstrates that the result is not just a temporary advertising fluctuation.

---

# 26. Target Milestone

The first financial goal should be:

> Karobakbak pays its own operating costs for three consecutive months.

Not:

- 100,000 users;
- ₹1 lakh revenue;
- viral growth.

Self-sustainability is the first proof that the service can justify continued hosting.

---

# 27. Suggested Initial Financial Target

Choose a monthly hobby budget.

Example:

```text
Target operating budget:
₹10,000–₹15,000/month
```

Then work backward:

```text
Required monthly revenue
        ↓
Revenue per active user
        ↓
Required MAU
        ↓
Required daily activity
        ↓
Required ad inventory
```

Replace every assumption with real measurements once the product launches.

---

# 28. Decision Tree

```text
                   Does anyone use it?
                         │
                ┌────────┴────────┐
                │                 │
               NO                YES
                │                 │
          Improve product      Is retention healthy?
                                  │
                           ┌──────┴──────┐
                           │             │
                          NO            YES
                           │             │
                     Improve UX      Test ads
                                         │
                                  Does revenue cover
                                     meaningful cost?
                                         │
                              ┌──────────┴──────────┐
                              │                     │
                             NO                    YES
                              │                     │
                         Optimize               Scale carefully
                              │                     │
                              └──────────┬──────────┘
                                         │
                              Revenue > Cost
                              for 3 months?
                                         │
                                  ┌──────┴──────┐
                                  │             │
                                 NO            YES
                                  │             │
                              Continue       SELF-SUSTAINING
                              testing
```

---

# 29. What Not To Do

Do not:

- maximize ads from day one;
- show ads between messages;
- use conversation content for targeting;
- spend heavily on infrastructure before traffic justifies it;
- scale servers simply because user count increased;
- interpret impressions as profit;
- ignore moderation costs;
- assume advertising revenue is constant;
- count one good month as sustainability;
- chase traffic that loses money.

---

# 30. Final Operating Principle

The platform should be treated as a small economic system:

```text
Users
  ↓
Usage
  ↓
Ad inventory
  ↓
Revenue
  ↓
Operating costs
  ↓
Margin
  ↓
Ability to continue operating
```

The desired flywheel is:

```text
Better product
    ↓
More healthy engagement
    ↓
More valuable ad inventory
    ↓
More revenue
    ↓
Operating costs covered
    ↓
More ability to improve product
```

The desired endpoint is not infinite growth.

It is:

> A safe, useful service whose users generate enough economic value to pay for the infrastructure required to serve them.
