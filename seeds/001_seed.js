import bcrypt from "bcryptjs";
import { authenticator } from "otplib";
import crypto from "node:crypto";
import "dotenv/config";

function encryptSecret(plaintext) {
  const key = Buffer.from(process.env.AES_KEY_MFA, "base64");
  const iv = crypto.randomBytes(12);
  const cipher = crypto.createCipheriv("aes-256-gcm", key, iv);
  const ct = Buffer.concat([cipher.update(plaintext, "utf8"), cipher.final()]);
  return Buffer.concat([iv, cipher.getAuthTag(), ct]);
}

const days = (start, n) => {
  const d = new Date(start); d.setDate(d.getDate() + n);
  return d.toISOString().slice(0, 10);
};

export async function seed(knex) {
  await knex("audit_entry").del();
  await knex("inquiry_message").del();
  await knex("inquiry").del();
  await knex("review").del();
  await knex("departure").del();
  await knex("tour_category").del();
  await knex("tour_image").del();
  await knex("tour").del();
  await knex("deal").del();
  await knex("category").del();
  await knex("session").del();
  await knex("user").del();
  await knex("rate_limit_bucket").del();

  /* ---- users ---- */
  const ADMIN_PASSWORD = "TrekOnIndia@2026!";
  const MFA_SECRET = authenticator.generateSecret();

  const [adminId] = await knex("user").insert({
    email: "admin@trekonindia.com",
    name: "Super Admin",
    role: "superadmin",
    password_hash: await bcrypt.hash(ADMIN_PASSWORD, 12),
    mfa_secret_enc: encryptSecret(MFA_SECRET),
    mfa_enabled: true,
  });
  await knex("user").insert([
    { email: "ops@trekonindia.com", name: "Operations", role: "ops",
      password_hash: await bcrypt.hash("OpsTrek@2026!", 12) },
    { email: "content@trekonindia.com", name: "Content Manager", role: "content",
      password_hash: await bcrypt.hash("ContentTrek@2026!", 12) },
  ]);

  /* ---- categories ---- */
  const cats = [
    { slug: "char-dham-yatra", name: "Char Dham & Yatra", kind: "category" },
    { slug: "himalayan-treks", name: "Himalayan Treks", kind: "category" },
    { slug: "popular-deals", name: "Popular Deals", kind: "collection" },
    { slug: "weekend-getaways", name: "Weekend Getaways", kind: "category" },
    { slug: "uttarakhand", name: "Uttarakhand", kind: "region" },
    { slug: "himachal", name: "Himachal Pradesh", kind: "region" },
  ];
  await knex("category").insert(cats);
  const catRows = await knex("category").select("id", "slug");
  const catId = Object.fromEntries(catRows.map(c => [c.slug, c.id]));

  /* ---- tours ---- */
  const tours = [
    {
      slug: "kedarnath-do-dham-5n6d",
      title: "Kedarnath Do Dham Yatra — 5N/6D",
      region: "Uttarakhand", difficulty: "moderate", duration_days: 6,
      from_price_inr: 15999, min_age: 7,
      description_md: "A guided Do Dham circuit covering Kedarnath and Badrinath with hotel stays, all transfers from Haridwar, and an experienced yatra coordinator throughout.",
      itinerary: [
        { day: 1, title: "Haridwar to Guptkashi", detail: "Morning pickup, drive via Devprayag confluence, overnight Guptkashi." },
        { day: 2, title: "Kedarnath trek", detail: "Drive to Sonprayag, 16 km trek or optional helicopter, evening darshan." },
        { day: 3, title: "Kedarnath to Guptkashi", detail: "Morning aarti, descend, rest at hotel." },
        { day: 4, title: "Guptkashi to Badrinath", detail: "Drive via Chopta and Joshimath, evening Badrinath darshan." },
        { day: 5, title: "Badrinath to Rudraprayag", detail: "Mana village visit, drive down." },
        { day: 6, title: "Return to Haridwar", detail: "Drop by evening." },
      ],
      inclusions: ["Hotel stays (twin sharing)", "Breakfast and dinner", "Tempo Traveller transfers", "Yatra coordinator", "All permits"],
      exclusions: ["Helicopter tickets", "Lunch", "Pony/palki charges", "Personal expenses"],
      categories: ["char-dham-yatra", "uttarakhand"], featured: true,
    },
    {
      slug: "char-dham-yatra-9n10d",
      title: "Complete Char Dham Yatra — 9N/10D",
      region: "Uttarakhand", difficulty: "moderate", duration_days: 10,
      from_price_inr: 32999, min_age: 7,
      description_md: "The full circuit: Yamunotri, Gangotri, Kedarnath, and Badrinath in one carefully paced itinerary with buffer days for weather.",
      itinerary: [
        { day: 1, title: "Haridwar to Barkot", detail: "Drive via Mussoorie, Kempty Falls." },
        { day: 2, title: "Yamunotri", detail: "6 km trek from Janki Chatti, return to Barkot." },
        { day: 3, title: "Barkot to Uttarkashi", detail: "Vishwanath temple evening visit." },
        { day: 4, title: "Gangotri", detail: "Darshan and Bhagirathi ghats, return Uttarkashi." },
        { day: 5, title: "Uttarkashi to Guptkashi", detail: "Long scenic drive." },
        { day: 6, title: "Kedarnath", detail: "Trek/heli, darshan, night at Kedarnath." },
        { day: 7, title: "Descend to Guptkashi", detail: "Rest." },
        { day: 8, title: "Guptkashi to Badrinath", detail: "Evening darshan." },
        { day: 9, title: "Badrinath to Rudraprayag", detail: "Mana village." },
        { day: 10, title: "Return Haridwar", detail: "Drop." },
      ],
      inclusions: ["All hotels", "MAP meals", "Transfers", "Coordinator", "Permits"],
      exclusions: ["Helicopter", "Lunch", "Pony/palki", "Insurance"],
      categories: ["char-dham-yatra", "uttarakhand"], featured: true,
    },
    {
      slug: "kedarkantha-trek-4n5d",
      title: "Kedarkantha Winter Trek — 4N/5D",
      region: "Uttarakhand", difficulty: "challenging", duration_days: 5,
      from_price_inr: 8999, min_age: 12,
      description_md: "The classic winter summit at 12,500 ft with pine forests, frozen Juda ka Talab, and a sunrise summit push. Certified trek leaders and full camping gear provided.",
      itinerary: [
        { day: 1, title: "Dehradun to Sankri", detail: "Shared cab, 8 hr drive, briefing." },
        { day: 2, title: "Sankri to Juda ka Talab", detail: "4 km ascent through pine forest, camp." },
        { day: 3, title: "To Kedarkantha base", detail: "Snow walk, base camp at 11,250 ft." },
        { day: 4, title: "Summit day", detail: "3 am start, summit 12,500 ft, descend to Sankri." },
        { day: 5, title: "Return Dehradun", detail: "Drop by evening." },
      ],
      inclusions: ["Camping and meals", "Trek leader + support staff", "Gaiters, microspikes", "Forest permits"],
      exclusions: ["Transport to Sankri (bookable add-on)", "Personal gear", "Insurance"],
      categories: ["himalayan-treks", "uttarakhand"], featured: true,
    },
    {
      slug: "manali-solang-4n5d",
      title: "Manali & Solang Valley Getaway — 4N/5D",
      region: "Himachal Pradesh", difficulty: "easy", duration_days: 5,
      from_price_inr: 11499, min_age: null,
      description_md: "Family-friendly Manali with Solang adventure day, Hadimba temple, old Manali cafés, and an optional Atal Tunnel excursion to Sissu.",
      itinerary: [
        { day: 1, title: "Arrive Manali", detail: "Check-in, Mall Road evening." },
        { day: 2, title: "Solang Valley", detail: "Ropeway, ATV, paragliding options." },
        { day: 3, title: "Atal Tunnel and Sissu", detail: "Lahaul day excursion." },
        { day: 4, title: "Local Manali", detail: "Hadimba, Vashisht hot springs, old Manali." },
        { day: 5, title: "Departure", detail: "Checkout and drop." },
      ],
      inclusions: ["Hotel with breakfast", "Private cab", "Sightseeing as listed"],
      exclusions: ["Adventure activity tickets", "Lunch and dinner", "Entry fees"],
      categories: ["weekend-getaways", "himachal"], featured: true,
    },
    {
      slug: "kasol-kheerganga-3n4d",
      title: "Kasol & Kheerganga Trek — 3N/4D",
      region: "Himachal Pradesh", difficulty: "moderate", duration_days: 4,
      from_price_inr: 6999, min_age: 14,
      description_md: "Parvati valley circuit: Kasol café culture, Chalal village walk, Manikaran gurudwara, and the overnight Kheerganga trek with hot springs at the top.",
      itinerary: [
        { day: 1, title: "Arrive Kasol", detail: "Riverside camps, Chalal walk." },
        { day: 2, title: "Kheerganga trek", detail: "12 km via Rudra Nag, camp at top." },
        { day: 3, title: "Descend, Manikaran", detail: "Hot springs, gurudwara, Kasol night." },
        { day: 4, title: "Departure", detail: "Morning bus." },
      ],
      inclusions: ["Camps both nights", "Breakfast + dinner", "Trek guide"],
      exclusions: ["Transport to Kasol", "Lunch", "Personal expenses"],
      categories: ["himalayan-treks", "weekend-getaways", "himachal"], featured: false,
    },
    {
      slug: "badrinath-express-3n4d",
      title: "Badrinath Express Darshan — 3N/4D",
      region: "Uttarakhand", difficulty: "easy", duration_days: 4,
      from_price_inr: 9499, min_age: null,
      description_md: "A compact ek-dham darshan for time-bound yatris: Haridwar to Badrinath and back with Mana village and Devprayag stops.",
      itinerary: [
        { day: 1, title: "Haridwar to Srinagar (Garhwal)", detail: "Devprayag sangam stop." },
        { day: 2, title: "To Badrinath", detail: "Evening darshan and aarti." },
        { day: 3, title: "Mana village, descend", detail: "Vyas Gufa, Bheem Pul, night Rudraprayag." },
        { day: 4, title: "Return Haridwar", detail: "Drop." },
      ],
      inclusions: ["Hotels", "Breakfast + dinner", "Cab", "Coordinator"],
      exclusions: ["Lunch", "VIP darshan fees"],
      categories: ["char-dham-yatra", "uttarakhand"], featured: false,
    },
  ];

  for (const t of tours) {
    const [tourId] = await knex("tour").insert({
      slug: t.slug, title: t.title, region: t.region, difficulty: t.difficulty,
      duration_days: t.duration_days, from_price_inr: t.from_price_inr, min_age: t.min_age,
      description_md: t.description_md,
      itinerary_json: JSON.stringify(t.itinerary),
      inclusions_json: JSON.stringify(t.inclusions),
      exclusions_json: JSON.stringify(t.exclusions),
      hero_image_path: `/uploads/tours/${t.slug}/hero.webp`,
      meta_title: t.title + " | Trek On India",
      meta_description: t.description_md.slice(0, 280),
      is_published: true, is_featured: t.featured, created_by: adminId,
    });
    await knex("tour_category").insert(t.categories.map(slug => ({ tour_id: tourId, category_id: catId[slug] })));

    // departures: next 8 weekly Saturdays
    const base = new Date("2026-07-11"); // first Saturday after today
    const deps = [];
    for (let w = 0; w < 8; w++) {
      const start = days(base, w * 7);
      deps.push({
        tour_id: tourId,
        start_date: start,
        end_date: days(start, t.duration_days - 1),
        capacity: t.difficulty === "easy" ? 24 : 16,
        price_inr: t.from_price_inr,
      });
    }
    await knex("departure").insert(deps);
  }

  /* ---- deal ---- */
  await knex("deal").insert({
    headline: "Yatra Season Special — flat 10% off Char Dham departures in July",
    body: "Applies to all confirmed July departures. Mention YATRA10 in your inquiry.",
    image_path: "/uploads/deals/yatra10.webp",
    cta_url: "/category/char-dham-yatra",
    active_from: new Date("2026-07-01"),
    active_to: new Date("2026-07-31"),
  });

  /* ---- sample review pending moderation ---- */
  const kedarnathTour = await knex("tour").where({ slug: "kedarnath-do-dham-5n6d" }).first();
  await knex("review").insert({
    tour_id: kedarnathTour.id, author_name: "Ramesh S.", rating: 5,
    title: "Smooth yatra, great coordinator",
    body_md: "Our group of 6 including my 68-year-old father completed the yatra comfortably. Hotels were clean and the coordinator handled everything.",
    status: "pending",
  });

  console.log("──────────────────────────────────────────────");
  console.log("Seed complete.");
  console.log("Super Admin login:  admin@trekonindia.com");
  console.log("Password:           " + ADMIN_PASSWORD);
  console.log("TOTP secret (add to Google Authenticator):");
  console.log("  " + MFA_SECRET);
  console.log("  otpauth://totp/TrekOnIndia%20Admin:admin%40trekonindia.com?secret=" + MFA_SECRET + "&issuer=TrekOnIndia%20Admin");
  console.log("Ops login: ops@trekonindia.com / OpsTrek@2026!  (MFA enrol on first login)");
  console.log("──────────────────────────────────────────────");
}
