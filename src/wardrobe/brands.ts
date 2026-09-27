/**
 * Brands as people type them (#24; plan section 16). A garment's brand is
 * free text, so "UNIQLO", "Uniqlo " and "uniqlo" must be one brand wherever
 * brands are compared: insights' brand breakdown and the per-brand size
 * notes (src/web/sizes). Pure.
 */

/** The brand as it is shown and stored: trimmed, runs of spaces made one. */
export function brandSpelling(brand: string): string {
  return brand.trim().replace(/\s+/g, ' ');
}

/**
 * What two spellings of one brand share; '' for a blank brand. The size
 * notes' unique index (`brand_size_user_id_lower_brand_unique`) compares
 * `lower(brand)` over the stored spelling, which is the same rule.
 */
export function brandKey(brand: string): string {
  return brandSpelling(brand).toLowerCase();
}
