// Which of a room's listings is the one in use. A room can be sold through several listings (En-Suite - Phil and
// En-Suite - Lewis), each with its own Airbnb calendar, and only one is normally being rented out: the one with most
// stays starting within two months either side of today (a one-off booking elsewhere in the year doesn't change who the
// room is let for); failing that, the one with the latest stay; failing that, the first. Pure: no state import.
// `stays`: [{listingId, checkin (ISO), status}], only status 'stay' counts.
function activeListingId(listingIds, stays, today) {
  const T = Date.parse(`${today}T00:00:00Z`);
  const mine = (stays || []).filter((x) => (listingIds || []).includes(x.listingId) && x.status === 'stay' && x.checkin);
  if (!mine.length) return (listingIds || [])[0];
  const near = new Map();
  mine.forEach((x) => { if (Math.abs(Date.parse(`${x.checkin}T00:00:00Z`) - T) <= 60 * 86400000) near.set(x.listingId, (near.get(x.listingId) || 0) + 1); });
  if (near.size) return [...near.entries()].sort((a, b) => b[1] - a[1])[0][0];
  return [...mine].sort((a, b) => String(b.checkin).localeCompare(String(a.checkin)))[0].listingId;
}
export { activeListingId };
