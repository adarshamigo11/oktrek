/** Initial schema — Trek On India. Mirrors Architecture doc §5.2. */

export async function up(knex) {
  await knex.schema.createTable("user", (t) => {
    t.bigIncrements("id");
    t.string("email", 255).notNullable().unique();
    t.string("password_hash", 255).nullable();
    t.string("name", 120).notNullable();
    t.string("phone_e164", 20).nullable();
    t.string("role", 20).notNullable().defaultTo("traveller"); // traveller|ops|content|superadmin|analyst
    t.binary("mfa_secret_enc").nullable();
    t.boolean("mfa_enabled").notNullable().defaultTo(false);
    t.integer("failed_logins").notNullable().defaultTo(0);
    t.datetime("locked_until").nullable();
    t.datetime("email_verified_at").nullable();
    t.boolean("consent_marketing").notNullable().defaultTo(false);
    t.datetime("created_at").notNullable().defaultTo(knex.fn.now());
    t.datetime("updated_at").notNullable().defaultTo(knex.fn.now());
    t.datetime("deleted_at").nullable();
  });

  await knex.schema.createTable("session", (t) => {
    t.string("id", 36).primary();
    t.bigInteger("user_id").unsigned().notNullable()
      .references("id").inTable("user").onDelete("CASCADE");
    t.datetime("expires_at").notNullable();
    t.string("ip_hash", 64).nullable();
    t.string("ua_fingerprint", 64).nullable();
    t.datetime("revoked_at").nullable();
    t.datetime("created_at").notNullable().defaultTo(knex.fn.now());
    t.index(["user_id"]);
  });

  await knex.schema.createTable("category", (t) => {
    t.increments("id");
    t.string("slug", 80).notNullable().unique();
    t.string("name", 120).notNullable();
    t.string("kind", 20).notNullable().defaultTo("category"); // category|region|collection
  });

  await knex.schema.createTable("tour", (t) => {
    t.bigIncrements("id");
    t.string("slug", 160).notNullable().unique();
    t.string("title", 200).notNullable();
    t.string("region", 80).notNullable().index();
    t.string("difficulty", 20).nullable(); // easy|moderate|challenging|strenuous|extreme
    t.smallint("duration_days").notNullable();
    t.decimal("from_price_inr", 10, 2).notNullable();
    t.smallint("min_age").nullable();
    t.text("description_md").nullable();
    t.text("itinerary_json").notNullable().defaultTo("[]");
    t.text("inclusions_json").notNullable().defaultTo("[]");
    t.text("exclusions_json").notNullable().defaultTo("[]");
    t.text("faq_json").nullable();
    t.text("cancellation_md").nullable();
    t.string("hero_image_path", 255).notNullable().defaultTo("");
    t.string("meta_title", 180).nullable();
    t.string("meta_description", 300).nullable();
    t.boolean("is_published").notNullable().defaultTo(false);
    t.boolean("is_featured").notNullable().defaultTo(false);
    t.decimal("rating_avg", 3, 2).notNullable().defaultTo(0);
    t.integer("rating_count").notNullable().defaultTo(0);
    t.bigInteger("created_by").unsigned().nullable()
      .references("id").inTable("user");
    t.datetime("created_at").notNullable().defaultTo(knex.fn.now());
    t.datetime("updated_at").notNullable().defaultTo(knex.fn.now());
    t.datetime("deleted_at").nullable();
    t.index(["is_published", "is_featured", "updated_at"]);
  });

  await knex.schema.createTable("tour_image", (t) => {
    t.bigIncrements("id");
    t.bigInteger("tour_id").unsigned().notNullable()
      .references("id").inTable("tour").onDelete("CASCADE");
    t.string("path", 255).notNullable();
    t.string("alt", 200).nullable();
    t.smallint("sort_order").notNullable().defaultTo(0);
    t.index(["tour_id"]);
  });

  await knex.schema.createTable("tour_category", (t) => {
    t.bigInteger("tour_id").unsigned().notNullable()
      .references("id").inTable("tour").onDelete("CASCADE");
    t.integer("category_id").unsigned().notNullable()
      .references("id").inTable("category").onDelete("CASCADE");
    t.primary(["tour_id", "category_id"]);
  });

  await knex.schema.createTable("departure", (t) => {
    t.bigIncrements("id");
    t.bigInteger("tour_id").unsigned().notNullable()
      .references("id").inTable("tour").onDelete("CASCADE");
    t.date("start_date").notNullable();
    t.date("end_date").notNullable();
    t.smallint("capacity").notNullable();
    t.smallint("confirmed_count").notNullable().defaultTo(0);
    t.decimal("price_inr", 10, 2).notNullable();
    t.string("status", 20).notNullable().defaultTo("scheduled"); // scheduled|filling|sold_out|cancelled
    t.text("notes_internal").nullable();
    t.unique(["tour_id", "start_date"]);
  });

  await knex.schema.createTable("inquiry", (t) => {
    t.bigIncrements("id");
    t.string("reference", 20).nullable().unique();
    t.bigInteger("tour_id").unsigned().notNullable().references("id").inTable("tour");
    t.bigInteger("departure_id").unsigned().nullable().references("id").inTable("departure");
    t.bigInteger("user_id").unsigned().nullable().references("id").inTable("user");
    t.string("name", 120).notNullable();
    t.string("email", 255).notNullable();
    t.string("phone_e164", 20).notNullable();
    t.smallint("travellers").notNullable();
    t.date("preferred_date").nullable();
    t.string("pickup_city", 80).nullable();
    t.text("message").nullable();
    t.string("source", 20).notNullable().defaultTo("web"); // web|whatsapp|phone|email|partner
    t.string("status", 20).notNullable().defaultTo("new"); // new|contacted|quote_sent|confirmed|completed|cancelled|lost
    t.bigInteger("assigned_to").unsigned().nullable().references("id").inTable("user");
    t.string("ip_hash", 64).nullable();
    t.string("ua", 255).nullable();
    t.text("consent_snapshot").nullable();
    t.datetime("created_at").notNullable().defaultTo(knex.fn.now());
    t.datetime("updated_at").notNullable().defaultTo(knex.fn.now());
    t.index(["status", "created_at"]);
  });

  await knex.schema.createTable("inquiry_message", (t) => {
    t.bigIncrements("id");
    t.bigInteger("inquiry_id").unsigned().notNullable()
      .references("id").inTable("inquiry").onDelete("CASCADE");
    t.bigInteger("author_id").unsigned().nullable().references("id").inTable("user");
    t.string("visibility", 10).notNullable(); // internal|customer
    t.text("body_md").notNullable();
    t.string("attachment_path", 255).nullable();
    t.datetime("created_at").notNullable().defaultTo(knex.fn.now());
    t.index(["inquiry_id"]);
  });

  await knex.schema.createTable("review", (t) => {
    t.bigIncrements("id");
    t.bigInteger("tour_id").unsigned().notNullable().references("id").inTable("tour");
    t.bigInteger("inquiry_id").unsigned().nullable().references("id").inTable("inquiry");
    t.string("author_name", 120).notNullable();
    t.tinyint("rating").notNullable();
    t.string("title", 160).nullable();
    t.text("body_md").notNullable();
    t.string("status", 10).notNullable().defaultTo("pending"); // pending|approved|rejected
    t.bigInteger("moderator_id").unsigned().nullable().references("id").inTable("user");
    t.string("moderator_note", 500).nullable();
    t.text("reply_body_md").nullable();
    t.datetime("created_at").notNullable().defaultTo(knex.fn.now());
    t.datetime("updated_at").notNullable().defaultTo(knex.fn.now());
    t.index(["tour_id", "status"]);
  });

  await knex.schema.createTable("deal", (t) => {
    t.increments("id");
    t.string("headline", 160).notNullable();
    t.string("body", 300).nullable();
    t.string("image_path", 255).notNullable().defaultTo("");
    t.string("cta_url", 255).notNullable();
    t.datetime("active_from").notNullable();
    t.datetime("active_to").notNullable();
    t.smallint("sort_order").notNullable().defaultTo(0);
  });

  await knex.schema.createTable("blog_post", (t) => {
    t.bigIncrements("id");
    t.string("slug", 160).notNullable().unique();
    t.string("title", 200).notNullable();
    t.string("excerpt", 400).nullable();
    t.text("body_md").nullable();
    t.string("hero_image_path", 255).nullable();
    t.datetime("published_at").nullable();
    t.bigInteger("author_id").unsigned().nullable().references("id").inTable("user");
    t.string("meta_title", 180).nullable();
    t.string("meta_description", 300).nullable();
  });

  await knex.schema.createTable("audit_entry", (t) => {
    t.bigIncrements("id");
    t.bigInteger("actor_id").unsigned().nullable();
    t.string("action", 80).notNullable();
    t.string("entity_type", 40).notNullable();
    t.bigInteger("entity_id").nullable();
    t.text("before_json").nullable();
    t.text("after_json").nullable();
    t.string("ip_hash", 64).nullable();
    t.string("ua", 255).nullable();
    t.datetime("created_at").notNullable().defaultTo(knex.fn.now());
    t.index(["entity_type", "entity_id"]);
  });

  await knex.schema.createTable("rate_limit_bucket", (t) => {
    t.string("key_hash", 64).primary();
    t.integer("counter").notNullable();
    t.datetime("window_start").notNullable();
  });
}

export async function down(knex) {
  const tables = [
    "rate_limit_bucket", "audit_entry", "blog_post", "deal", "review",
    "inquiry_message", "inquiry", "departure", "tour_category", "tour_image",
    "tour", "category", "session", "user",
  ];
  for (const t of tables) await knex.schema.dropTableIfExists(t);
}
