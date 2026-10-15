-- The eight logical entities of SPEC.md "Data model": the source of truth, one table each, not
-- pre-joined (DATA-001). Created WITHOUT keys or indexes; the loader bulk-loads with COPY and then
-- applies indexes.sql, the order the PostgreSQL manual ("Populating a Database") recommends.
--
-- Mapping from the wire model (packages/spec model.ts) to storage:
--   camelCase fields          -> snake_case columns
--   money                     -> bigint minor units (DATA-002); parsed to exact JS integers
--   product.reviewRollup      -> review_count, review_average_centistars
--   variant.options           -> jsonb (a free-form option map)
--   cart.lines                -> jsonb array of {sku, quantity}, as the spec embeds them; a
--                                cart is read and cached as one unit and never queried by line
--   inventory.id              -> not stored; the key is (sku, location_id) as SPEC.md names it,
--                                and the write surface parses the wire id `${sku}:${locationId}`
--   promotion.tierKeys /
--   promotion.categoryKeys    -> tier_keys / category_keys, the dataset's indexable form of the
--                                eligibility arrays ('*' = unrestricted), GIN-indexed

-- Statement statistics (preloaded by postgresql.conf); used to verify every hot statement is an
-- index lookup, never by the application.
CREATE EXTENSION IF NOT EXISTS pg_stat_statements;

DROP TABLE IF EXISTS cart, inventory, variant, product, customer, promotion, rate, location, dataset_manifest CASCADE;

CREATE TABLE location (
	id        text    NOT NULL,
	region    text    NOT NULL,
	priority  integer NOT NULL
);

CREATE TABLE rate (
	id            text    NOT NULL,
	kind          text    NOT NULL CHECK (kind IN ('shipping', 'tax')),
	region        text    NOT NULL,
	weight_min    integer NOT NULL,
	weight_max    integer NOT NULL,
	jurisdiction  text    NOT NULL,
	amount_minor  bigint  NOT NULL,
	basis_points  integer NOT NULL
);

CREATE TABLE promotion (
	id                   text    NOT NULL,
	kind                 text    NOT NULL CHECK (kind IN ('exclusive', 'threshold', 'bogo', 'stackable')),
	tiers                text[]  NOT NULL,
	skus                 text[]  NOT NULL,
	category_ids         text[]  NOT NULL,
	tier_keys            text[]  NOT NULL,
	category_keys        text[]  NOT NULL,
	threshold_minor      bigint  NOT NULL,
	amount_minor         bigint  NOT NULL,
	amount_basis_points  integer NOT NULL
);

CREATE TABLE customer (
	id                text   NOT NULL,
	tier              text   NOT NULL,
	loyalty_balance   bigint NOT NULL,
	region            text   NOT NULL,
	tax_jurisdiction  text   NOT NULL
);

CREATE TABLE product (
	id                         text    NOT NULL,
	title                      text    NOT NULL,
	category_ids               text[]  NOT NULL,
	weight                     integer NOT NULL,
	related_product_ids        text[]  NOT NULL,
	review_count               integer NOT NULL,
	review_average_centistars  integer NOT NULL
);

-- Updated by the background writer (base_price is not indexed), so leave room on each page for
-- HOT updates.
CREATE TABLE variant (
	sku         text    NOT NULL,
	product_id  text    NOT NULL,
	options     jsonb   NOT NULL,
	base_price  bigint  NOT NULL,
	weight      integer NOT NULL
) WITH (fillfactor = 90);

CREATE TABLE inventory (
	sku          text    NOT NULL,
	location_id  text    NOT NULL,
	on_hand      integer NOT NULL
) WITH (fillfactor = 90);

CREATE TABLE cart (
	id           text  NOT NULL,
	customer_id  text  NOT NULL,
	lines        jsonb NOT NULL
);

-- Which dataset is loaded (DATA-003): the manifest's identity and per-file checksums, verified
-- before loading and recorded so a run can state what it ran against.
CREATE TABLE dataset_manifest (
	scale              text        NOT NULL,
	seed               text        NOT NULL,
	generator_version  text        NOT NULL,
	spec_version       text        NOT NULL,
	files              jsonb       NOT NULL,
	loaded_at          timestamptz NOT NULL DEFAULT now()
);
