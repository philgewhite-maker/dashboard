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

export { MARKET_SEASON, MARKET_CREDIT, creditHtml };
