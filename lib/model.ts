// The token radar's model: one snapshot of the protocol universe in, one ranked board out.
//
// The board ranks every protocol the snapshot records as pre-token that is not a wrapped, staked or
// bridged product of a token that already trades, and not an exchange: the house's own watchlist rule,
// applied to the whole snapshot instead of only the watchlist floor. The watchlist is the floor, never
// a ceiling: the board also ranks the 29 pre-token protocols above the floor the watchlist leaves out
// and every rankable protocol below it.
//
// Implied value follows only from the snapshot's own figures, and the base multiple is calibrated from
// the snapshot itself: the market's own mcap/TVL ratios on the protocols whose token already trades.
//
//   calibration  For each category with at least 3 live-token protocols carrying a market cap and a
//                TVL, take the median mcap/TVL, winsorized to [0.02, 1.5], and shrink it toward the
//                global median with weight n / (n + 5). A category with fewer live protocols, or none,
//                takes the global median. The final multiple is clamped to [0.05, 1.0].
//   base         = tvl_usd x multiple[category]
//   growth       = clamp(change_7d, -60, 120) per cent
//   growthMult   = 1 + (growth / 100) x GROWTH_WEIGHT
//   maturity     = 0.6 + 0.4 x sqrt(min(age_days, 1095) / 1095)   (age_days unknown: 365)
//   chainMult    = 1 + CHAIN_WEIGHT x ln(max(chains, 1))
//   implied      = max(1, round(base x growthMult x maturityMult x chainMult))
//
// No protocol name is ever special-cased: the same function scores every row, and the calibration is
// recomputed from the snapshot on every run. The dashboard states the constants, shows the calibration
// table, and lets the reader change the constants in a sandbox and watch the board re-rank.

/** The snapshot's protocol entry: exactly the ten fields the sealed input carries. */
export interface SnapshotProtocol {
  slug: string;
  name: string;
  category: string | null;
  chains: string[];
  tvl_usd: number;
  change_7d: number | null;
  mcap_usd: number | null;
  listed_at: string | null;
  gecko_id: string | null;
  symbol: string | null;
}

/** The whole snapshot document. */
export interface Snapshot {
  as_of: string;
  source: string;
  floor_usd: number;
  protocols: SnapshotProtocol[];
  watchlist: string[];
}

/** The model's constants, as the dashboard states them and the sandbox may change them. */
export interface ModelConstants {
  /** An exploratory change to the peer-fitted log(TVL) slope. */
  size_slope_adjustment: number;
  /** A scenario multiplier applied after the peer fit. */
  value_scale: number;
  /** TVL at which the fitted mcap/TVL multiple is anchored. */
  anchor_tvl_usd: number;
}

export const MODEL: ModelConstants = {
  size_slope_adjustment: 0,
  value_scale: 1,
  anchor_tvl_usd: 100_000_000,
};

/** The model's version label: the dashboard names it. */
export const MODEL_VERSION = 'radar-3';

/** How many live-token protocols the Live token view carries, by market cap. */
export const LIVE_ROWS = 24;

/** A snapshot-fitted size curve and held-out evaluation. */
export interface Calibration {
  anchor_tvl_usd: number;
  slope: number;
  log_intercept: number;
  global_median_multiple: number;
  live_count: number;
  leave_one_out_count: number;
  leave_one_out_median_miss_factor: number;
  global_leave_one_out_median_miss_factor: number;
  walk_forward_count: number;
  walk_forward_median_miss_factor: number;
  global_walk_forward_median_miss_factor: number;
  peer_error_low_factor: number;
  peer_error_high_factor: number;
}

/** A farm step: the action, what it costs, and how long it takes. */
export interface FarmStep {
  text: string;
  cost: string;
  time: string;
}

/** One row of board.json: the ranked board's row. */
export interface BoardRow {
  rank: number;
  slug: string;
  name: string;
  category: string | null;
  chains: string[];
  tvl_usd: number;
  change_7d: number | null;
  mcap_usd: number | null;
  listed_at: string | null;
  gecko_id: string | null;
  symbol: string | null;
  token_status: 'pre-token';
  age_days: number | null;
  implied_value_usd: number;
  base_multiple: number;
  peer_range_low_usd: number;
  peer_range_high_usd: number;
  model: { size_slope: number; peer_error_low_factor: number; peer_error_high_factor: number };
  farm_steps: string[];
}

/** The dashboard's compact view of one row, with its farm plan as board.json carries it. */
export interface RadarRow {
  rank: number;
  slug: string;
  name: string;
  category: string | null;
  chains: string[];
  tvl_usd: number;
  change_7d: number | null;
  mcap_usd: number | null;
  listed_at: string | null;
  age_days: number | null;
  implied_value_usd: number;
  base_multiple: number;
  peer_range_low_usd: number;
  peer_range_high_usd: number;
  size_slope: number;
  farm_steps: string[];
}

/** A live-token protocol: it already trades, so the board shows the market's own value, not a model's. */
export interface LiveRow {
  slug: string;
  name: string;
  category: string | null;
  chains: string[];
  tvl_usd: number;
  mcap_usd: number | null;
  change_7d: number | null;
}

/** Everything the dashboard needs: the board, the live set, the calibration and the model it runs. */
export interface RadarData {
  as_of: string;
  source: string;
  floor_usd: number;
  model: ModelConstants;
  model_version: string;
  watchlist_size: number;
  board_size: number;
  early_size: number;
  above_floor_size: number;
  live_size: number;
  total_implied_usd: number;
  calibration: Calibration;
  rows: RadarRow[];
  live: LiveRow[];
}

/** Why the snapshot is not one this model can score. */
export class SnapshotError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'SnapshotError';
  }
}

const DAY_MS = 86_400_000;

/** A finite number, else `fallback`. */
function finite(value: unknown, fallback: number): number {
  return typeof value === 'number' && Number.isFinite(value) ? value : fallback;
}

/** The median of a non-empty list, or null when it is empty. */
function median(values: number[]): number | null {
  if (values.length === 0) return null;
  const sorted = [...values].sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  return sorted.length % 2 === 1 ? sorted[mid]! : (sorted[mid - 1]! + sorted[mid]!) / 2;
}

/** A whole day count from `from` to `to`, clamped at zero; null when either date is absent or bad. */
export function ageDays(asOf: string, listedAt: string | null): number | null {
  if (listedAt === null) return null;
  const a = Date.parse(`${asOf}T00:00:00Z`);
  const b = Date.parse(`${listedAt}T00:00:00Z`);
  if (!Number.isFinite(a) || !Number.isFinite(b)) return null;
  return Math.max(0, Math.floor((a - b) / DAY_MS));
}

/**
 * Fit a robust log(mcap/TVL) power curve from listed-token peers. Each leave-one-out
 * prediction omits its target, and the ordered split uses only strictly earlier listings.
 */
export function calibrate(snapshot: Snapshot, model: ModelConstants = MODEL): Calibration {
  const anchor = model.anchor_tvl_usd;
  const live = snapshot.protocols
    .filter((p) => p.mcap_usd !== null && p.mcap_usd > 0 && p.tvl_usd > 0 && p.listed_at !== null &&
      !['CEX', 'Bridge', 'Canonical Bridge', 'Liquid Staking', 'Liquid Restaking', 'Restaked BTC'].includes(p.category ?? ''))
    .sort((a, b) => a.listed_at! < b.listed_at! ? -1 : a.listed_at! > b.listed_at! ? 1 : a.slug.localeCompare(b.slug));

  type Point = { p: SnapshotProtocol; x: number; y: number; date: string };
  const points: Point[] = live.map((p) => ({
    p, x: Math.log(p.tvl_usd / anchor), y: Math.log(p.mcap_usd! / p.tvl_usd), date: p.listed_at!,
  }));
  const globalLog = median(points.map((r) => r.y)) ?? Math.log(0.25);

  const fit = (rows: Point[]): { slope: number; intercept: number } => {
    if (rows.length < 2) return { slope: 0, intercept: median(rows.map((r) => r.y)) ?? globalLog };
    const slopes: number[] = [];
    for (let i = 0; i < rows.length; i++) for (let j = i + 1; j < rows.length; j++) {
      const dx = rows[i]!.x - rows[j]!.x;
      if (Math.abs(dx) > 1e-9) slopes.push((rows[i]!.y - rows[j]!.y) / dx);
    }
    const slope = Math.max(-1.5, Math.min(1.5, median(slopes) ?? 0));
    return { slope, intercept: median(rows.map((r) => r.y - slope * r.x)) ?? globalLog };
  };
  const quantile = (values: number[], q: number): number => {
    if (!values.length) return 0;
    const sorted = [...values].sort((a, b) => a - b);
    const at = (sorted.length - 1) * q, lo = Math.floor(at), hi = Math.ceil(at);
    return sorted[lo]! + (sorted[hi]! - sorted[lo]!) * (at - lo);
  };
  const miss = (actual: number, predicted: number): number => Math.exp(Math.abs(actual - predicted));
  const globalPrediction = (train: Point[], point: Point): number =>
    Math.log(point.p.tvl_usd) + (median(train.map((r) => r.y)) ?? globalLog);

  const loo: number[] = [], looGlobal: number[] = [], signedErrors: number[] = [];
  for (let i = 0; i < points.length; i++) {
    const train = points.filter((_, j) => j !== i);
    if (train.length < 2) continue;
    const f = fit(train), point = points[i]!;
    const prediction = Math.log(point.p.tvl_usd) + f.intercept + f.slope * point.x;
    const actual = Math.log(point.p.mcap_usd!);
    loo.push(miss(actual, prediction));
    looGlobal.push(miss(actual, globalPrediction(train, point)));
    signedErrors.push(actual - prediction);
  }

  const walk: number[] = [], walkGlobal: number[] = [];
  const cutoff = points[Math.floor(points.length * 0.42)]?.date;
  if (cutoff) for (const point of points) {
    if (point.date <= cutoff) continue;
    const train = points.filter((r) => r.date < point.date);
    if (train.length < 20) continue;
    const f = fit(train), prediction = Math.log(point.p.tvl_usd) + f.intercept + f.slope * point.x;
    const actual = Math.log(point.p.mcap_usd!);
    walk.push(miss(actual, prediction));
    walkGlobal.push(miss(actual, globalPrediction(train, point)));
  }

  const full = fit(points);
  return {
    anchor_tvl_usd: anchor,
    slope: full.slope,
    log_intercept: full.intercept,
    global_median_multiple: Math.exp(globalLog),
    live_count: points.length,
    leave_one_out_count: loo.length,
    leave_one_out_median_miss_factor: median(loo) ?? 1,
    global_leave_one_out_median_miss_factor: median(looGlobal) ?? 1,
    walk_forward_count: walk.length,
    walk_forward_median_miss_factor: median(walk) ?? 1,
    global_walk_forward_median_miss_factor: median(walkGlobal) ?? 1,
    peer_error_low_factor: Math.max(0.01, Math.exp(quantile(signedErrors, 0.1))),
    peer_error_high_factor: Math.min(100, Math.max(1, Math.exp(quantile(signedErrors, 0.9)))),
  };
}

/** The multipliers and the implied value one protocol gets under `model` and `calibration`. */
export function impliedValue(
  protocol: SnapshotProtocol,
  asOf: string,
  model: ModelConstants,
  calibration: Calibration,
): { implied: number; multiple: number; slope: number; low: number; high: number; age: number | null } {
  const age = ageDays(asOf, protocol.listed_at);
  const slope = calibration.slope + model.size_slope_adjustment;
  const x = Math.log(protocol.tvl_usd / calibration.anchor_tvl_usd);
  const multiple = Math.max(0.0001, Math.min(10,
    Math.exp(calibration.log_intercept + slope * x) * model.value_scale));
  const cap = (factor: number): number => Math.max(1, Math.min(100_000_000_000_000,
    Math.round(protocol.tvl_usd * multiple * factor)));
  return { implied: cap(1), multiple, slope, low: cap(calibration.peer_error_low_factor),
    high: cap(calibration.peer_error_high_factor), age };
}

/** DefiLlama's version-marker rule: a name ending in a release is a pool of another protocol. */
const VERSIONED = /\s(V\d+(\.\d+)?|v\d+(\.\d+)?|\d+\.\d+)$/;
/** A name beginning with an exchange's name is that exchange's product, not a standalone protocol. */
const EXCHANGE_NAMED = /^(Binance|Coinbase|Bybit|Kraken|Bitget|OKX|Bitfinex|Gemini)\b/i;
/** A name carrying a whole word wrapped, staked or staking is a wrapped or staked product. */
const WRAPPED_NAMED = /\b(wrapped|staked|staking)\b/i;
/**
 * Categories the board never ranks: exchanges, and the wrapped, staked, bridged and canonical-bridge
 * products whose value is another token's. The house's watchlist rule names them; the board applies the
 * same rule to every candidate, so the top of the board is never a wrapped token.
 */
const EXCLUDED_CATEGORIES = new Set(['CEX', 'Liquid Staking', 'Liquid Restaking', 'Restaked BTC', 'Canonical Bridge', 'Bridge']);

/** Whether a protocol records no token at all. */
export function isPreToken(p: SnapshotProtocol): boolean {
  return p.mcap_usd === null && p.gecko_id === null && p.symbol === null;
}

/** Whether a protocol is one the board may rank: pre-token, and not a wrapped, staked, bridged or exchange product. */
export function isRankable(p: SnapshotProtocol): boolean {
  return (
    isPreToken(p) &&
    (p.category === null || !EXCLUDED_CATEGORIES.has(p.category)) &&
    !VERSIONED.test(p.name) &&
    !EXCHANGE_NAMED.test(p.name) &&
    !WRAPPED_NAMED.test(p.name)
  );
}

/** The snapshot's protocol by slug. */
function bySlug(protocols: SnapshotProtocol[]): Map<string, SnapshotProtocol> {
  return new Map(protocols.map((p) => [p.slug, p]));
}

const round4 = (n: number): number => Math.round(n * 1e4) / 1e4;

/** The protocols the board ranks, strongest first, with ranks 1..n. */
export function buildBoard(snapshot: Snapshot, model: ModelConstants = MODEL, calibration: Calibration = calibrate(snapshot, model)): BoardRow[] {
  const index = bySlug(snapshot.protocols);
  const chosen = new Map<string, SnapshotProtocol>();
  // The watchlist is the floor: every slug, even one the snapshot no longer carries (it cannot, but the
  // board's coverage is the gate's row and is never gambled on a missing record).
  for (const slug of snapshot.watchlist) {
    const p = index.get(slug);
    if (p !== undefined) chosen.set(slug, p);
  }
  // The early radar: every rankable pre-token protocol the watchlist does not name, above the floor as
  // well as below it. Never a replacement for a watchlist row: a chosen protocol stays chosen.
  for (const p of snapshot.protocols) {
    if (!chosen.has(p.slug) && isRankable(p)) chosen.set(p.slug, p);
  }

  const scored = [...chosen.values()].map((p) => {
    const v = impliedValue(p, snapshot.as_of, model, calibration);
    return { p, ...v };
  });
  scored.sort((a, b) => b.implied - a.implied || (a.p.slug < b.p.slug ? -1 : a.p.slug > b.p.slug ? 1 : 0));
  return scored.map((s, i) => ({
    rank: i + 1,
    slug: s.p.slug,
    name: s.p.name,
    category: s.p.category,
    chains: s.p.chains,
    tvl_usd: s.p.tvl_usd,
    change_7d: s.p.change_7d,
    mcap_usd: s.p.mcap_usd,
    listed_at: s.p.listed_at,
    gecko_id: s.p.gecko_id,
    symbol: s.p.symbol,
    token_status: 'pre-token',
    age_days: s.age,
    implied_value_usd: s.implied,
    base_multiple: round4(s.multiple),
    peer_range_low_usd: s.low,
    peer_range_high_usd: s.high,
    model: {
      size_slope: round4(s.slope),
      peer_error_low_factor: round4(calibration.peer_error_low_factor),
      peer_error_high_factor: round4(calibration.peer_error_high_factor),
    },
    farm_steps: farmSteps(s.p, s.age).map(stepText),
  }));
}

/** A step as one string: its action, then its cost and time, within the gate's 20..600 characters. */
export function stepText(step: FarmStep): string {
  let s = `${step.text} Cost: ${step.cost}. Time: ${step.time}.`;
  if (s.length > 600) s = `${s.slice(0, 596)}...`;
  if (s.length < 20) s = `${s} Hold the position and check the protocol's own page.`;
  return s;
}

/** The first chain a protocol names, or a neutral phrase. */
function chainOf(p: SnapshotProtocol): string {
  return p.chains.length > 0 ? p.chains[0]! : 'its main chain';
}

/** How much capital one farm position needs, from the protocol's own TVL. */
function capitalFor(p: SnapshotProtocol): number {
  if (p.tvl_usd >= 5_000_000_000) return 250;
  if (p.tvl_usd >= 1_000_000_000) return 150;
  if (p.tvl_usd >= 100_000_000) return 100;
  return 50;
}

/** How long to hold, from the protocol's age: younger protocols get a longer qualifying window. */
function holdDaysFor(age: number | null): number {
  if (age === null) return 30;
  if (age < 180) return 60;
  if (age < 365) return 45;
  return 30;
}

/** The category's main action, in the words a farmer can follow. */
function actionFor(p: SnapshotProtocol, capital: number, chain: string): string {
  const c = (p.category ?? '').toLowerCase();
  const name = p.name;
  if (c.includes('lend') || c.includes('cdp') || c.includes('collateral')) return `Supply $${capital} of USDC to ${name} on ${chain} and keep the position open.`;
  if (c.includes('dex') || c.includes('leveraged farm')) return `Provide $${capital} of liquidity to ${name}'s largest pool on ${chain} and keep the position open.`;
  if (c.includes('yield') || c.includes('farm')) return `Deposit $${capital} into ${name}'s highest-yield vault on ${chain} and keep the shares.`;
  if (c.includes('bridge')) return `Bridge $${capital} of USDC to ${chain} through ${name} and use the bridged funds in its app.`;
  if (c.includes('staking') || c.includes('restak')) return `Stake $${capital} of the chain's staking asset through ${name} and keep the receipt.`;
  if (c.includes('perpetual') || c.includes('derivative')) return `Deposit $${capital} of USDC as margin on ${name} and open one small hedged position.`;
  if (c.includes('prediction')) return `Fund $${capital} and place one market position on ${name}.`;
  if (c.includes('curator') || c.includes('allocator')) return `Deposit $${capital} into a ${name} vault on ${chain} and keep the shares.`;
  if (c.includes('stable')) return `Mint or deposit $${capital} of the stable asset through ${name} on ${chain}.`;
  if (c.includes('rwa')) return `Mint $${capital} of the protocol's yield asset on ${chain} and hold it.`;
  if (c.includes('insurance')) return `Buy $${capital} of cover from ${name} on ${chain} and keep the policy.`;
  if (c.includes('basis')) return `Deposit $${capital} into ${name}'s basis vault on ${chain} and keep the receipt.`;
  if (c.includes('options')) return `Deposit $${capital} of USDC as collateral on ${name} and open one small option position.`;
  if (c.includes('privacy')) return `Deposit $${capital} through ${name}'s shielded pool on ${chain} and keep the note safe.`;
  if (c.includes('index')) return `Buy $${capital} of ${name}'s index token on ${chain} and hold it.`;
  if (c.includes('launchpad')) return `Stake $${capital} on ${name} to qualify for its next sale on ${chain}.`;
  if (c.includes('chain')) return `Move $${capital} onto ${name}'s chain and make one transaction in its main app.`;
  return `Deposit $${capital} of USDC into ${name} on ${chain} and keep the position open.`;
}

/** The category's second action: a different kind of activity, so the account is not one transaction. */
function secondActionFor(p: SnapshotProtocol, capital: number, chain: string): string {
  const c = (p.category ?? '').toLowerCase();
  const name = p.name;
  const third = Math.max(10, Math.round(capital / 3));
  if (c.includes('lend') || c.includes('cdp') || c.includes('collateral')) return `Borrow about $${third} against the supply and repay it within the week, so the borrow side of your activity is counted too.`;
  if (c.includes('dex') || c.includes('leveraged farm')) return `Add the same capital to a second pool on ${chain}, or tighten the range on your first pool, so more than one pool records your address.`;
  if (c.includes('yield') || c.includes('farm')) return `Stake the vault receipt token if ${name} offers a staking contract, so the receipt itself earns while you hold it.`;
  if (c.includes('perpetual') || c.includes('derivative') || c.includes('options')) return `Close the first position and open a fresh one on a different market, so the account shows more than one trade.`;
  if (c.includes('prediction')) return `Settle the first market and place a second position on a different outcome.`;
  if (c.includes('curator') || c.includes('allocator')) return `Deposit into a second ${name} vault with a different risk profile, so two vaults record your address.`;
  if (c.includes('stable') || c.includes('rwa')) return `Use the minted asset once in another protocol, so the mint is not the only action on record.`;
  if (c.includes('basis')) return `Read ${name}'s funding-rate page and note whether the basis is positive before adding any more capital.`;
  if (c.includes('chain')) return `Interact with one more app on ${name}'s chain beyond the first, so the address shows real usage.`;
  if (c.includes('insurance')) return `Read the policy's claim conditions and note the coverage period before the position ends.`;
  return `Make one more qualifying action of a different kind, a swap, a vote or a second deposit, so the account is not a single-transaction wallet.`;
}

/** The category's risk, in one sentence: what can go wrong with this kind of position. */
function riskFor(p: SnapshotProtocol): string {
  const c = (p.category ?? '').toLowerCase();
  if (c.includes('dex') || c.includes('leveraged farm')) return `Liquidity positions lose value when the pair's prices move apart (impermanent loss); a narrow range earns more fees and loses more to the move.`;
  if (c.includes('lend') || c.includes('cdp') || c.includes('collateral')) return `A borrow can be liquidated if the collateral's price falls, so keep any loan well below the protocol's limit.`;
  if (c.includes('perpetual') || c.includes('derivative') || c.includes('options')) return `Leverage cuts both ways: a small move against a margined position can liquidate it, so keep the position small.`;
  if (c.includes('stable')) return `A stable asset can lose its peg; check what backs it and how it has held its price before sizing up.`;
  if (c.includes('rwa')) return `Real-world backing depends on the issuer's off-chain holdings; read the attestation before trusting the yield.`;
  if (c.includes('bridge')) return `Bridges hold funds on two chains at once; a bridge exploit can freeze or lose the bridged amount.`;
  if (c.includes('staking') || c.includes('restak')) return `Staked assets can be slashed or locked; check the unbonding period before staking anything.`;
  if (c.includes('yield') || c.includes('farm')) return `High yields usually come from token emissions or leverage; check where the yield comes from before adding capital.`;
  if (c.includes('prediction')) return `Prediction markets can resolve against you in full; never stake more than the position you planned.`;
  return `Every protocol can be exploited; never farm with funds you cannot afford to lose, and check whether the code is audited.`;
}

/**
 * A protocol's farm plan: eight or nine steps, each an action with a cost and a time. The plan is
 * derived from the protocol's own record (category, chains, TVL, age), never from a hand-written list
 * of names. Multi-chain protocols get a second-chain step; every plan names the risk of its category.
 */
export function farmSteps(p: SnapshotProtocol, age: number | null): FarmStep[] {
  const chain = chainOf(p);
  const capital = capitalFor(p);
  const hold = holdDaysFor(age);
  const action = actionFor(p, capital, chain);
  const second = secondActionFor(p, capital, chain);
  const risk = riskFor(p);
  const gas = capital >= 150 ? 8 : 4;
  const steps: FarmStep[] = [
    {
      text: `Use a fresh wallet that holds only the funds you plan to farm, and keep its seed phrase offline.`,
      cost: 'under $3 of gas for the first transaction',
      time: '5 minutes',
    },
    {
      text: action,
      cost: `$${capital} of capital and about $${gas} of gas`,
      time: '15 minutes to set up',
    },
    {
      text: second,
      cost: `about $${gas} of gas`,
      time: '10 minutes',
    },
  ];
  if (p.chains.length >= 2) {
    steps.push({
      text: `Open the same position on ${p.chains[1]} with half the capital, so the farm is not tied to one chain's snapshot.`,
      cost: `$${Math.round(capital / 2)} of capital and about $${gas} of gas`,
      time: '15 minutes',
    });
  }
  steps.push(
    {
      text: `Make one qualifying action each week, such as a deposit, a borrow, a swap or a vote.`,
      cost: 'about $2 of gas a week',
      time: '10 minutes a week',
    },
    {
      text: `Hold the position for at least ${hold} days so the activity is counted in more than one snapshot.`,
      cost: `the $${capital} stays in the position`,
      time: `${hold} days`,
    },
    {
      text: `Know the risk before you size up: ${risk}`,
      cost: 'nothing but ten minutes of reading',
      time: '10 minutes',
    },
    {
      text: `Before you withdraw, open the protocol's own points or rewards page and claim only from the link it publishes.`,
      cost: 'no fee to check, and never pay to claim',
      time: '10 minutes',
    },
    {
      text: `Write the wallet, the dates and every transaction in a farm log so you can repeat the position or unwind it.`,
      cost: 'nothing but the log',
      time: '5 minutes',
    },
  );
  return steps;
}

/** The live-token protocols, by market cap, for the dashboard's Live token view. */
export function liveRows(snapshot: Snapshot): LiveRow[] {
  return snapshot.protocols
    .filter((p) => !isPreToken(p) && p.category !== 'CEX')
    .sort((a, b) => (b.mcap_usd ?? 0) - (a.mcap_usd ?? 0) || b.tvl_usd - a.tvl_usd)
    .slice(0, LIVE_ROWS)
    .map((p) => ({
      slug: p.slug,
      name: p.name,
      category: p.category,
      chains: p.chains,
      tvl_usd: p.tvl_usd,
      mcap_usd: p.mcap_usd,
      change_7d: p.change_7d,
    }));
}

/** A board row's compact form for data.js, with the farm plan as board.json carries it. */
export function radarRow(row: BoardRow): RadarRow {
  return {
    rank: row.rank,
    slug: row.slug,
    name: row.name,
    category: row.category,
    chains: row.chains,
    tvl_usd: row.tvl_usd,
    change_7d: row.change_7d,
    mcap_usd: row.mcap_usd,
    listed_at: row.listed_at,
    age_days: row.age_days,
    implied_value_usd: row.implied_value_usd,
    base_multiple: row.base_multiple,
    peer_range_low_usd: row.peer_range_low_usd,
    peer_range_high_usd: row.peer_range_high_usd,
    size_slope: row.model.size_slope,
    farm_steps: row.farm_steps,
  };
}

/** Everything the dashboard renders, from the snapshot. */
export function buildRadar(snapshot: Snapshot, model: ModelConstants = MODEL): { board: BoardRow[]; radar: RadarData } {
  const calibration = calibrate(snapshot, model);
  const board = buildBoard(snapshot, model, calibration);
  const live = liveRows(snapshot);
  const watchlist = new Set(snapshot.watchlist);
  const early = board.filter((r) => !watchlist.has(r.slug) && r.tvl_usd < snapshot.floor_usd).length;
  const aboveFloor = board.filter((r) => !watchlist.has(r.slug) && r.tvl_usd >= snapshot.floor_usd).length;
  const radar: RadarData = {
    as_of: snapshot.as_of,
    source: snapshot.source,
    floor_usd: snapshot.floor_usd,
    model,
    model_version: MODEL_VERSION,
    watchlist_size: snapshot.watchlist.length,
    board_size: board.length,
    early_size: early,
    above_floor_size: aboveFloor,
    live_size: live.length,
    total_implied_usd: board.reduce((n, r) => n + r.implied_value_usd, 0),
    calibration,
    rows: board.map(radarRow),
    live,
  };
  return { board, radar };
}

/** The snapshot out of a file's text, refused unless it is the shape the model scores. */
export function parseSnapshot(text: string): Snapshot {
  let raw: unknown;
  try {
    raw = JSON.parse(text);
  } catch {
    throw new SnapshotError('snapshot.json is not JSON');
  }
  if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) throw new SnapshotError('snapshot.json is not a JSON object');
  const o = raw as Record<string, unknown>;
  if (typeof o.as_of !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(o.as_of)) throw new SnapshotError('snapshot.json has no as_of date');
  if (typeof o.source !== 'string') throw new SnapshotError('snapshot.json has no source');
  if (typeof o.floor_usd !== 'number' || !Number.isSafeInteger(o.floor_usd) || o.floor_usd <= 0) throw new SnapshotError('snapshot.json has no floor_usd');
  if (!Array.isArray(o.protocols)) throw new SnapshotError('snapshot.json has no protocols array');
  if (!Array.isArray(o.watchlist) || o.watchlist.some((s) => typeof s !== 'string')) throw new SnapshotError('snapshot.json has no watchlist of slugs');
  const protocols = o.protocols.map((v, i) => {
    if (typeof v !== 'object' || v === null || Array.isArray(v)) throw new SnapshotError(`snapshot.json's protocol ${i} is not an object`);
    const p = v as Record<string, unknown>;
    if (typeof p.slug !== 'string' || typeof p.name !== 'string' || typeof p.tvl_usd !== 'number' || !Number.isFinite(p.tvl_usd)) {
      throw new SnapshotError(`snapshot.json's protocol ${i} lacks a slug, a name or a TVL`);
    }
    return {
      slug: p.slug,
      name: p.name,
      category: typeof p.category === 'string' ? p.category : null,
      chains: Array.isArray(p.chains) ? p.chains.filter((c): c is string => typeof c === 'string') : [],
      tvl_usd: p.tvl_usd,
      change_7d: typeof p.change_7d === 'number' && Number.isFinite(p.change_7d) ? p.change_7d : null,
      mcap_usd: typeof p.mcap_usd === 'number' && Number.isFinite(p.mcap_usd) ? p.mcap_usd : null,
      listed_at: typeof p.listed_at === 'string' ? p.listed_at : null,
      gecko_id: typeof p.gecko_id === 'string' ? p.gecko_id : null,
      symbol: typeof p.symbol === 'string' ? p.symbol : null,
    };
  });
  return {
    as_of: o.as_of,
    source: o.source,
    floor_usd: o.floor_usd,
    protocols,
    watchlist: o.watchlist as string[],
  };
}

/** Why a board is not one the gate will take, or null: coverage, ranks, order, one shared implied value, and farm steps. */
export function boardIssue(board: BoardRow[], snapshot: Snapshot): string | null {
  if (board.length < 100 || board.length > 4000) return `the board holds ${board.length} rows, outside the gate's 100 to 4000`;
  const slugs = new Set(board.map((r) => r.slug));
  const missing = snapshot.watchlist.filter((s) => !slugs.has(s));
  if (missing.length > 0) return `the board misses ${missing.length} watchlist slug${missing.length === 1 ? '' : 's'}: ${missing.slice(0, 5).join(', ')}`;
  const ranks = board.map((r) => r.rank).sort((a, b) => a - b);
  for (let i = 0; i < ranks.length; i++) if (ranks[i] !== i + 1) return `rank ${i + 1} is ${ranks[i]}`;
  for (let i = 1; i < board.length; i++) if (board[i]!.implied_value_usd > board[i - 1]!.implied_value_usd) return `row ${i + 1} outranks row ${i} on implied value`;
  if (board.length >= 2 && board[0]!.implied_value_usd === board[board.length - 1]!.implied_value_usd) {
    return `all ${board.length} rows share the same implied value $${board[0]!.implied_value_usd}: a board that ranks nothing by value is not a ranking`;
  }
  for (const r of board) {
    const steps = r.farm_steps;
    if (steps.length < 3 || steps.length > 12) return `${r.slug} has ${steps.length} farm steps`;
    for (const s of steps) {
      const t = s.trim();
      if (t.length < 20 || t.length > 600) return `${r.slug} has a farm step of ${t.length} characters`;
    }
    if (!Number.isSafeInteger(r.implied_value_usd) || r.implied_value_usd <= 0 || r.implied_value_usd > 100_000_000_000_000) {
      return `${r.slug} has implied value ${r.implied_value_usd}`;
    }
    if (typeof r.slug !== 'string' || r.slug.length < 1 || r.slug.length > 128 || /\s/.test(r.slug)) return `${r.slug} is not a valid slug`;
    if (typeof r.name !== 'string' || r.name.length === 0) return `${r.slug} has no name`;
  }
  return null;
}

/** A compact data.js: the dashboard's whole dataset as one script, no fetch and no network. */
export function dataScript(radar: RadarData): string {
  return `window.RADAR=${JSON.stringify(radar)};\n`;
}
