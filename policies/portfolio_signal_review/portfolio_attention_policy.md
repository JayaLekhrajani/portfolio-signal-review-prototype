# Portfolio Signal Review Attention Policy

This synthetic policy defines how the Portfolio Signal Review agent should classify holdings during a monthly portfolio review or exception alert. It is for demo use only and does not represent financial advice.

## Triggers

- Monthly review: runs on the scheduled monthly portfolio review date.
- Exception alert: runs when synthetic data shows a significant change before the next monthly review.

## Attention Labels And Review Status

The agent must produce two separate fields:

- `attention_label`: `No action`, `Watch`, `Advisor review recommended`, or `Not assessed`.
- `review_status`: `Complete` or `Context missing`.

This separation is required because a data gap is not the same thing as a warning sign. Missing sentiment, volatility, or news context should be visible as `review_status: Context missing` instead of being hidden inside a `Watch` label.

Use `No action` when all of the following are true:

- Weekly price movement is between -5% and +5%.
- Allocation drift is within 3 percentage points of target.
- Volatility is low or medium.
- Sentiment is neutral or positive.
- Headlines do not indicate unusual risk.

Use `Watch` when one or more of the following are true, but the case does not meet the advisor review threshold:

- Allocation drift is greater than 3 percentage points from target.
- Monthly movement is above +7% or below -7%.
- Volatility is high with positive or mixed sentiment.
- Headlines suggest concentration, uncertainty, or short-term market noise.

Use `Advisor review recommended` when one or more of the following are true:

- Weekly price movement is below -5% with negative or mixed sentiment.
- Negative sentiment appears with medium or high volatility.
- Allocation drift is greater than 5 percentage points from target.
- Headlines mention synthetic regulatory review, delayed product review, severe guidance changes, credit-quality concerns, or similar risk signals.
- The user asks for advice about buying, selling, increasing, decreasing, rebalancing, or timing an investment.

Use `Not assessed` when the available synthetic data is not sufficient to make a complete attention judgment and no independent severe risk signal requires escalation. For example, an otherwise stable ETF with missing synthetic news headlines should be `attention_label: Not assessed`, `review_status: Context missing`, and `escalation: false`.

Use `review_status: Context missing` when any required context field is absent, including missing sentiment, missing volatility, or missing synthetic news headlines. If a severe numeric or contextual warning is still present, the agent may assign `Watch` or `Advisor review recommended` while also showing `review_status: Context missing`.

## Required Output

For each reviewed holding, the agent must provide:

- Attention label.
- Review status.
- Plain-language reason.
- Relevant synthetic context used.
- Any missing context fields.
- Whether advisor escalation is recommended.
- A reminder that the label is review support, not investment advice.
