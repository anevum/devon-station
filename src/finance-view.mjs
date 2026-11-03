/** Pure, strict projection for a private, READ-ONLY financial display. */
const SOURCE_STATUS = new Set(['available', 'unavailable', 'not_configured']);
const ALPACA_STATUS = new Set([...SOURCE_STATUS, 'live_access_not_authorized']);
const CENTS = /^-?(?:0|[1-9][0-9]{0,16})$/;

function requiredCents(value) {
  if (typeof value !== 'string' || !CENTS.test(value) || value === '-0') {
    throw Error('Invalid finance amount');
  }
  return value;
}
function requiredLabel(value, maximum=100) {
  if (typeof value !== 'string' || !value.trim() || value.length > maximum || /[\x00-\x1f\x7f]/.test(value)) {
    throw Error('Invalid finance label');
  }
  return value.trim();
}
function moneyOnly(value) { return requiredCents(value); }

/** Never convert balances to floating-point numbers. */
export function financeDisplayMoney(value) {
  const amount = BigInt(requiredCents(value));
  const neg = amount < 0n;
  const digits = (neg ? -amount : amount).toString().padStart(3, '0');
  const whole = digits.slice(0, -2).replace(/\B(?=(\d{3})+(?!\d))/g, ',');
  return (neg ? '-$' : '$') + whole + '.' + digits.slice(-2);
}

export function financeNormalizeSnapshot(data) {
  if (!data || typeof data !== 'object' || Array.isArray(data) ||
      data.schema !== 'devonstation-financial-readonly-v1' || data.mode !== 'read_only' ||
      data.combinedNetWorthCents !== null) {
    throw Error('Invalid finance contract');
  }
  if (!data.capabilities || typeof data.capabilities !== 'object' ||
      data.capabilities.moneyMovement !== false ||
      data.capabilities.orderSubmission !== false ||
      data.capabilities.liveTrading !== false ||
      data.capabilities.unverifiedTPD !== false) {
    throw Error('Finance capabilities not read-only');
  }
  if (typeof data.fetchedAt !== 'string' || !/^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d/.test(data.fetchedAt) ||
      !Number.isFinite(Date.parse(data.fetchedAt))) {
    throw Error('Invalid finance observation timestamp');
  }
  const bank = data.sources?.mercury;
  const broker = data.sources?.alpaca;
  if (!SOURCE_STATUS.has(bank?.status) || bank.readOnly !== true ||
      !ALPACA_STATUS.has(broker?.status) || broker.readOnly !== true) {
    throw Error('Invalid finance source state');
  }
  let mercuryAccounts = [];
  if (bank.status === 'available') {
    if (!Array.isArray(bank.accounts) || bank.accounts.length > 1000) throw Error('Invalid bank accounts');
    mercuryAccounts = bank.accounts.map(account => {
      if (!account || typeof account !== 'object' || Array.isArray(account)) throw Error('Invalid bank account');
      return {
        label: requiredLabel(account.label),
        kind: requiredLabel(account.kind, 40),
        status: requiredLabel(account.status, 30),
        currentCents: moneyOnly(account.currentCents),
        availableCents: moneyOnly(account.availableCents),
      };
    });
  }
  let alpaca = null;
  if (broker.status === 'available') {
    if (broker.mode !== 'paper' ||
        !Number.isInteger(broker.positionsCount) || broker.positionsCount < 0 || broker.positionsCount > 500 ||
        broker.tpd?.status !== 'unavailable_pending_reconciliation' || broker.tpd?.valuePct !== null) {
      throw Error('Unverified trading data');
    }
    alpaca = {
      accountStatus: requiredLabel(broker.accountStatus, 30),
      equityCents: moneyOnly(broker.equityCents),
      cashCents: moneyOnly(broker.cashCents),
      buyingPowerCents: moneyOnly(broker.buyingPowerCents),
      positionsCount: broker.positionsCount,
      tpdStatus: 'awaiting_reconciliation',
    };
  }
  // The returned shape is an allowlist. Raw provider IDs, tokens, routing data,
  // and unknown fields are never forwarded into DOM rendering.
  return {
    fetchedAt: data.fetchedAt,
    mercury: {status: bank.status, accounts: mercuryAccounts},
    alpaca: {status: broker.status, account: alpaca},
    combinedNetWorth: null,
  };
}
