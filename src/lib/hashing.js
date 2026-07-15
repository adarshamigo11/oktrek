import bcrypt from "bcryptjs";

const COST = 12; // Security doc §4.1

// Top breached passwords blocked at set-time (representative subset; extend from
// the top-10k list before launch — Security doc §4.1).
const BREACHED = new Set([
  "password", "password1", "password123", "123456", "12345678", "123456789",
  "qwerty", "qwerty123", "abc123", "iloveyou", "admin", "admin123",
  "welcome", "welcome1", "letmein", "monkey", "dragon", "india123",
]);

export async function hashPassword(plain) {
  if (plain.length < 10) throw Object.assign(new Error("Password must be at least 10 characters"), { status: 422 });
  if (BREACHED.has(plain.toLowerCase())) throw Object.assign(new Error("Password appears in breach lists; choose another"), { status: 422 });
  return bcrypt.hash(plain, COST);
}

export async function verifyPassword(plain, hash) {
  if (!hash) return false;
  return bcrypt.compare(plain, hash);
}
