// Public market data the booking model leans on where your own history is thin.
//
// Seasonal index of London private-room stays by month of the year (1 = an average month), from the dates of guest
// reviews, a proxy for stays that lags them by days. Central boroughs (Westminster, Camden, Tower Hamlets, Lambeth,
// Southwark, Islington, Hackney, Hammersmith and Fulham, Kensington and Chelsea, City of London), private rooms,
// 2023, 2024 and 2025 pooled (the three years agree to within about 0.1 in every month).
//
// Source: Inside Airbnb (insideairbnb.com), London reviews file, September 2026 snapshot, licensed CC BY 4.0.
// Inside Airbnb is not affiliated with Airbnb. Wherever this is shown or used the credit must travel with it.
const MARKET_SEASON_RAW = [0.62, 0.64, 0.83, 0.90, 1.13, 1.20, 1.22, 1.00, 1.09, 1.17, 1.08, 1.12];
const MEAN = MARKET_SEASON_RAW.reduce((a, b) => a + b, 0) / 12;
// Normalised to average exactly 1 over the year. Index 0 = January.
const MARKET_SEASON = MARKET_SEASON_RAW.map((v) => v / MEAN);

const MARKET_CREDIT = 'Market season: Inside Airbnb (insideairbnb.com), London reviews, central-borough private rooms 2023–25, CC BY 4.0';
const creditHtml = () => 'Market season: <a href="https://insideairbnb.com" target="_blank" rel="noopener">Inside Airbnb</a> (London reviews, central-borough private rooms, 2023–25), licensed <a href="https://creativecommons.org/licenses/by/4.0/" target="_blank" rel="noopener">CC BY 4.0</a>.';

// London private-room PRICES by month of the year (1 = an average month), and the yearly rise in them.
// Read off AirROI's "How Does ADR Change Over Time?" chart (median, London, Private room, Upscale tier), Dec 2023 to
// Oct 2026, 35 months, then fitted as ln(price) = level + rise x years + month effect, so the rise over the three years
// is not read as season. All private rooms, and the upscale top quarter, gave the same shape (Feb lowest, Jul highest)
// with a 7% and 13% range; this one sits between them at 9%. The rise was +8.3% a year (all rooms +11%, top quarter +4%).
// The figures are AirROI's estimates from scraped calendars, read from a chart at pixel precision (about 1%).
// Read again every few months (MARKET_PRICE_REFRESH_DAYS): the page is MARKET_PRICE_URL, filters Private Room + Upscale.
const MARKET_PRICE_SEASON_RAW = [0.978, 0.964, 0.973, 0.994, 1.005, 1.037, 1.046, 1.026, 0.992, 0.988, 0.984, 1.017];
const GMEAN = Math.exp(MARKET_PRICE_SEASON_RAW.reduce((a, b) => a + Math.log(b), 0) / 12);
const MARKET_PRICE_SEASON = MARKET_PRICE_SEASON_RAW.map((v) => v / GMEAN);
const MARKET_PRICE_RISE_PAST = 0.083; // a year, Dec 2023 to Oct 2026: used to put past stays on today's price level
const MARKET_PRICE_ASOF = '2026-11-27';
const MARKET_PRICE_REFRESH_DAYS = 120;
const MARKET_PRICE_URL = 'https://www.airroi.com/atlas/charts/rates?country-code=GB&state=England&city=London';
const MARKET_PRICE_CREDIT = 'Market price season and rise: AirROI (airroi.com), London private rooms, upscale tier, Dec 2023 – Oct 2026';

export { MARKET_SEASON, MARKET_CREDIT, creditHtml, MARKET_PRICE_SEASON, MARKET_PRICE_RISE_PAST, MARKET_PRICE_ASOF, MARKET_PRICE_REFRESH_DAYS, MARKET_PRICE_URL, MARKET_PRICE_CREDIT };
