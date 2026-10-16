-- Keys and indexes, applied after the bulk load. One index per access path the application
-- uses, and nothing speculative.

ALTER TABLE location  ADD PRIMARY KEY (id);
ALTER TABLE rate      ADD PRIMARY KEY (id);
ALTER TABLE promotion ADD PRIMARY KEY (id);
ALTER TABLE customer  ADD PRIMARY KEY (id);
ALTER TABLE product   ADD PRIMARY KEY (id);
ALTER TABLE variant   ADD PRIMARY KEY (sku);
ALTER TABLE cart      ADD PRIMARY KEY (id);

-- Quote wave 3 and the product aggregate both read on_hand by (sku, location_id). INCLUDE makes
-- those index-only scans: at bench scale the inventory heap is the largest relation and does not
-- fit in memory, and the visibility map keeps nearly every page all-visible under a low write rate.
ALTER TABLE inventory ADD PRIMARY KEY (sku, location_id) INCLUDE (on_hand);

-- Product aggregate: a product's variants.
CREATE INDEX variant_product_id_idx ON variant (product_id);

-- Promotion candidates (SPEC 0.3.0): array overlap on the sentinel-carrying eligibility keys for
-- the promotions open to every SKU, and on `skus` for the rest. The first two are partial, so a
-- SKU-scoped promotion never enters the tier/category scan; it is a candidate only through its SKUs.
CREATE INDEX promotion_tier_keys_idx     ON promotion USING gin (tier_keys)     WHERE skus = '{}'::text[];
CREATE INDEX promotion_category_keys_idx ON promotion USING gin (category_keys) WHERE skus = '{}'::text[];
CREATE INDEX promotion_skus_idx          ON promotion USING gin (skus);

-- Referential integrity. Never checked by the hot path (no write changes a referencing column).
ALTER TABLE variant   ADD FOREIGN KEY (product_id)  REFERENCES product (id);
ALTER TABLE inventory ADD FOREIGN KEY (sku)         REFERENCES variant (sku);
ALTER TABLE inventory ADD FOREIGN KEY (location_id) REFERENCES location (id);
ALTER TABLE cart      ADD FOREIGN KEY (customer_id) REFERENCES customer (id);
