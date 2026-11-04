# Treasury memo convention

The site's explorer has a Treasury tab (`/explorer?tab=treasury`) that lists what the project
treasury received and spent, read from mainnet by `@blindseal/chain-reads` (`getTreasurySnapshot`).
It has no database: every row is an SPL token transfer or burn found in the history of the treasury
wallet (`BLINDSEAL_TREASURY`) and of its USDC token accounts, and the row's kind comes from an
**SPL Memo instruction in the same transaction**. Anything that pays the treasury or spends from it
— the hosted prover, the dogfood service, a buyback or burn script — follows this.

## The memo

One Memo instruction (program `MemoSq4gqABAXKb96qnH8TysNcWxMyWCqXgDLGmfcHr`) in the transaction that
carries the transfer or the burn. UTF-8, lower-case, exact:

| memo                 | what the row is                                  | direction          |
|----------------------|--------------------------------------------------|--------------------|
| `blindseal:proof`    | a proof bought: the buyer's USDC into the treasury | USDC in            |
| `blindseal:payout`   | a payout from the treasury                        | USDC out           |
| `blindseal:buyback`  | USDC spent on a buyback                           | USDC out           |
| `blindseal:burn`     | tokens destroyed by the treasury                  | burn (any mint)    |

- The first whitespace-separated word decides. Free text may follow after one space, e.g.
  `blindseal:proof att_01JC…` or `blindseal:payout 2026-11`; it is kept on the row as `memo` and
  shown nowhere by default. Keep it content-free: no names, no e-mail addresses, nothing from a payload.
- A transfer with no memo, or with any other text, is listed as **other** and counts in no total.
- Only the first memo in a transaction is read (top-level instructions first, then inner ones).
- Case matters: `blindseal:Proof` is "other".

## What is counted

Rows are parsed from `jsonParsed` instructions of the SPL Token program: `transfer`,
`transferChecked`, `burn`, `burnChecked`, top-level and inner. A transfer is a row when exactly one
side is the treasury (its wallet or one of its USDC token accounts) and the mint is USDC
(`EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v`). A burn is a row when the burned account belongs
to the treasury or the treasury signed as authority, whatever the mint. The counterparty is the
**owner** of the other token account (from the transaction's token balances), falling back to the
account itself; on a burn it is the mint.

Totals (`TreasuryTotals`), over rows that are not internal:

| total               | rule                                                      |
|---------------------|-----------------------------------------------------------|
| proofs bought       | count of `proof` rows with USDC in                        |
| USDC collected      | sum of those rows                                         |
| USDC paid out       | sum of `payout` rows with USDC out                        |
| USDC on buybacks    | sum of `buyback` rows with USDC out                       |
| tokens burned       | count of `burn` rows; the burned amount summed per mint   |

## The internal wallet

`BLINDSEAL_DOGFOOD_WALLET` names the wallet the dogfood service pays from. A row whose counterparty
(or signing authority) is that wallet is shown with the label **internal (dogfood)** and is excluded
from every total, so the public numbers never count the project paying itself.

## Server configuration

| variable                   | meaning                                                       |
|----------------------------|---------------------------------------------------------------|
| `BLINDSEAL_TREASURY`       | the treasury wallet (base58). Unset → the tab says "not configured" and nothing is read |
| `BLINDSEAL_DOGFOOD_WALLET` | the internal wallet (base58), optional                        |
| `BLINDSEAL_RPC_URL`        | as for the explorer: the RPC to read from; `off` disables reads |

The read is server-side only (the browser never contacts an RPC), bounded to the last 1000
signatures per address, and cached in module memory for 60 s. `GET /explorer/treasury` returns the
same snapshot as JSON for the tab's Retry.
