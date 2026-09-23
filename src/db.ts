/** Small shared helpers: ids, time, hashing, events. No ORM, no repositories. */

const ID_ALPHABET = "abcdefghijklmnopqrstuvwxyz0123456789";

export function newId(prefix: string, length = 10): string {
	const bytes = crypto.getRandomValues(new Uint8Array(length));
	let out = "";
	for (const b of bytes) out += ID_ALPHABET[b % ID_ALPHABET.length];
	return `${prefix}_${out}`;
}

export function randomToken(prefix: string): string {
	const bytes = crypto.getRandomValues(new Uint8Array(32));
	return `${prefix}_${base64url(bytes)}`;
}

export function base64url(bytes: Uint8Array): string {
	let bin = "";
	for (const b of bytes) bin += String.fromCharCode(b);
	return btoa(bin).replaceAll("+", "-").replaceAll("/", "_").replace(/=+$/, "");
}

export async function sha256Hex(input: string): Promise<string> {
	const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(input));
	return [...new Uint8Array(digest)].map((b) => b.toString(16).padStart(2, "0")).join("");
}

export async function sha256Base64url(input: string): Promise<string> {
	const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(input));
	return base64url(new Uint8Array(digest));
}

export function nowIso(): string {
	return new Date().toISOString();
}

export function isoPlusSeconds(seconds: number): string {
	return new Date(Date.now() + seconds * 1000).toISOString();
}

/** Drop null/undefined fields so tool responses stay compact for the model. */
export function compact<T extends object>(obj: T): Partial<T> {
	const out: Record<string, unknown> = {};
	for (const [k, v] of Object.entries(obj)) {
		if (v !== null && v !== undefined) out[k] = v;
	}
	return out as Partial<T>;
}

export function parseJsonArray<T>(text: string | null | undefined): T[] {
	if (!text) return [];
	try {
		const v = JSON.parse(text);
		return Array.isArray(v) ? (v as T[]) : [];
	} catch {
		return [];
	}
}

export type Role = "owner" | "agent";

/** Who is calling, resolved from the bearer token. */
export interface Actor {
	tokenId: string;
	role: Role;
	/** Set for agent tokens: the one project the agent works on. */
	projectId: string | null;
	name: string;
	client: string | null;
}

export interface EventInput {
	projectId: string;
	taskId?: number | null;
	type: string;
	summary: string;
	details?: unknown;
	/** Overrides the actor name, e.g. with the agent label a claim was made under. */
	actorName?: string;
}

export function eventStatement(
	db: D1Database,
	actor: Pick<Actor, "name" | "role">,
	event: EventInput,
	/** Only insert when the previous statement in the batch changed exactly one row. */
	guarded = false,
): D1PreparedStatement {
	return db
		.prepare(
			`INSERT INTO events (project_id, task_id, created_at, actor, role, type, summary, details)
			 SELECT ?, ?, ?, ?, ?, ?, ?, ? ${guarded ? "WHERE changes() = 1" : ""}`,
		)
		.bind(
			event.projectId,
			event.taskId ?? null,
			nowIso(),
			event.actorName ?? actor.name,
			actor.role,
			event.type,
			event.summary,
			event.details === undefined ? null : JSON.stringify(event.details),
		);
}

/** Build `col1 = ?, col2 = ?` from a partial record, skipping undefined values. */
export function setClause(fields: Record<string, unknown>): { sql: string; values: unknown[] } {
	const cols: string[] = [];
	const values: unknown[] = [];
	for (const [col, value] of Object.entries(fields)) {
		if (value === undefined) continue;
		cols.push(`${col} = ?`);
		values.push(value);
	}
	return { sql: cols.join(", "), values };
}

export function placeholders(n: number): string {
	return Array.from({ length: n }, () => "?").join(", ");
}
