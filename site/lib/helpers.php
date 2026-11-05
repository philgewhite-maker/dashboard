<?php
// Small formatting helpers shared by every template.

function h($s): string { return htmlspecialchars((string) $s, ENT_QUOTES | ENT_SUBSTITUTE, 'UTF-8'); }

function gbp($n, int $dp = 0): string { return '£' . number_format((float) $n, $dp); }

function slugify(string $s): string {
    return trim(strtolower(preg_replace('/[^a-z0-9]+/i', '-', $s)), '-');
}

function pretty_date(?string $d): string {
    if (!$d) return '';
    $t = strtotime(substr($d, 0, 10));
    return $t ? date('j F Y', $t) : $d;
}

function plural(int $n, string $one, ?string $many = null): string {
    return $n . ' ' . ($n === 1 ? $one : ($many ?? $one . 's'));
}

// Internal link: honours basePath so the same build works on a domain root or in a subfolder.
function url(string $path): string {
    global $CFG;
    return rtrim($CFG['basePath'], '/') . $path;
}

function abs_url(string $path): string {
    global $CFG;
    return rtrim($CFG['baseUrl'], '/') . rtrim($CFG['basePath'], '/') . $path;
}

// "£2,000" -> 2000 style text for plain-English lists: "a, b and c".
function join_and(array $items): string {
    $items = array_values(array_filter($items, fn($x) => $x !== '' && $x !== null));
    if (count($items) <= 1) return $items[0] ?? '';
    $last = array_pop($items);
    return implode(', ', $items) . ' and ' . $last;
}

// "Barclays's" / "NatWest's" / "Lloyds’": possessive of a bank name.
function possessive(string $name): string {
    return $name . (substr($name, -1) === 's' ? '’' : '’s');
}

// A link that opens in the same tab to another page of this site.
function a(string $path, string $text, string $class = ''): string {
    return '<a href="' . h(url($path)) . '"' . ($class ? ' class="' . h($class) . '"' : '') . '>' . $text . '</a>';
}

// An outbound link to a source or to a provider. `$sponsored` marks affiliate links.
function ext(string $href, string $text, bool $sponsored = false): string {
    $rel = $sponsored ? 'sponsored nofollow noopener' : 'noopener';
    return '<a href="' . h($href) . '" target="_blank" rel="' . $rel . '">' . $text . '</a>';
}
