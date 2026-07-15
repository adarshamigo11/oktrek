export async function up(knex) {
  await knex.schema.createTable("app_setting", (t) => {
    t.string("key", 80).primary();
    t.text("value").nullable();
    t.datetime("updated_at").notNullable().defaultTo(knex.fn.now());
    t.bigInteger("updated_by").unsigned().nullable().references("id").inTable("user");
  });

  await knex.schema.createTable("notification_log", (t) => {
    t.bigIncrements("id");
    t.string("channel", 20).notNullable(); // whatsapp|email|sms
    t.string("direction", 10).notNullable().defaultTo("outbound");
    t.string("recipient", 80).notNullable();
    t.string("template", 80).notNullable();
    t.string("status", 20).notNullable(); // sent|dev_logged|skipped|failed
    t.string("provider_message_id", 160).nullable();
    t.bigInteger("inquiry_id").unsigned().nullable().references("id").inTable("inquiry").onDelete("SET NULL");
    t.text("payload_json").nullable();
    t.text("error").nullable();
    t.datetime("created_at").notNullable().defaultTo(knex.fn.now());
    t.index(["channel", "status", "created_at"]);
    t.index(["inquiry_id"]);
  });

  await knex("app_setting").insert([
    { key: "brand_name", value: "Trek On India" },
    { key: "brand_logo_url", value: "" },
    { key: "whatsapp_enabled", value: "0" },
    { key: "whatsapp_phone_number_id", value: "" },
    { key: "whatsapp_access_token", value: "" },
    { key: "whatsapp_ops_number", value: "+919812345678" },
    { key: "whatsapp_notify_customer", value: "1" },
  ]);
}

export async function down(knex) {
  await knex.schema.dropTableIfExists("notification_log");
  await knex.schema.dropTableIfExists("app_setting");
}
