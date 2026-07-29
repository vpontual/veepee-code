// Tax rates by region code.
const RATES = {
  us_ca: 0.0725,
  us_ny: 0.08875,
  eu_de: 0.19,
};

export function rateFor(region) {
  return RATES[region] ?? 0;
}

// Applies tax to an amount given in CENTS and returns CENTS.
export function withTax(amountCents, region) {
  return Math.round(amountCents * (1 + rateFor(region)));
}
