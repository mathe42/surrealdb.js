import guid from "./utils/guid.ts";
import {
	AuthenticationError,
	PermissionError,
	RecordError,
} from "./errors/index.ts";
import { Live } from "./classes/live.ts";
import { ConnectionState, Socket } from "./classes/socket.ts";
import { Pinger } from "./classes/pinger.ts";
import { Emitter } from "./classes/emitter.ts";
import { EventName } from "./classes/emitter.ts";
import { Auth, Patch, Result } from "./types/index.ts";

let singleton: Surreal;

interface SurrealBaseEventMap {
	open: [];
	opened: [];
	close: [];
	closed: [];
	// deno-lint-ignore no-explicit-any
	notify: [any];
}

export class Surreal extends Emitter<
	& SurrealBaseEventMap
	& {
		[
			K in Exclude<
				EventName,
				keyof SurrealBaseEventMap
			>
			// deno-lint-ignore no-explicit-any
		]: [Result<any>];
	}
> {
	// ------------------------------
	// Main singleton
	// ------------------------------

	/**
	 * The Instance static singleton ensures that a single database instance is available across very large or complicated applications.
	 * With the singleton, only one connection to the database is instantiated, and the database connection does not have to be shared
	 * across components or controllers.
	 * @return A Surreal instance.
	 */
	static get Instance(): Surreal {
		return singleton ? singleton : singleton = new Surreal();
	}

	// ------------------------------
	// Properties
	// ------------------------------
	#ws!: Socket;

	#token?: string;

	#pinger!: Pinger;

	#attempted?: Promise<void>;

	// ------------------------------
	// Accessors
	// ------------------------------
	get token(): string | undefined {
		return this.#token;
	}

	set token(token) {
		this.#token = token;
    if(this.status !== ConnectionState.NOT_CONNECTED) {
      this.#init();
    }
	}

	get status(): ConnectionState {
		if (!this.#ws) {
			return ConnectionState.NOT_CONNECTED;
		}

		return this.#ws.status;
	}

	// ------------------------------
	// Methods
	// ------------------------------
	/**
	 * Initializee a SurrealDb.
	 * @param url - The url of the database endpoint to connect to.
	 * @param token - The authorization token.
	 */
	constructor(url?: string, token?: string) {
		super();

		this.#token = token;

		if (url) {
			this.connect(url);
		}
	}

	/**
	 * Connects to a local or remote database endpoint.
	 * @param url - The url of the database endpoint to connect to.
	 */
	connect(url: string): Promise<void> {
		// Next we setup the websocket connection
		// and listen for events on the socket,
		// specifying whether logging is enabled.
		this.#ws = new Socket(url);

		// Setup the interval pinger so that the
		// connection is kept alive through
		// loadbalancers and proxies.
		this.#pinger = new Pinger(30000);

		// When the connection is opened we
		// need to attempt authentication if
		// a token has already been applied.
		this.#ws.on("open", () => {
			this.#init();
		});

		// When the connection is opened we
		// change the relevant properties
		// open live queries, and trigger.
		this.#ws.on("open", () => {
			this.emit("open");
			this.emit("opened");

			this.#pinger.start(() => {
				this.ping();
			});
		});

		// When the connection is closed we
		// change the relevant properties
		// stop live queries, and trigger.
		this.#ws.on("close", () => {
			this.emit("close");
			this.emit("closed");

			this.#pinger.stop();
		});

		// When we receive a socket message
		// we process it. If it has an ID
		// then it is a query response.
		this.#ws.on("message", (e) => {
			const d = JSON.parse(e.data);

			if (d.method !== "notify") {
				return this.emit(d.id, d);
			}

			if (d.method === "notify") {
				return d.params.forEach((r: undefined) => {
					this.emit("notify", r);
				});
			}
		});

		// Open the websocket for the first
		// time. This will automatically
		// attempt to reconnect on failure.
		this.#ws.open();

		//
		//
		//
		return this.wait();
	}

	// --------------------------------------------------
	// Public methods
	// --------------------------------------------------
	sync(query: string, vars?: Record<string, unknown>): Live {
		return new Live(this, query, vars);
	}

	/**
	 * Waits for the connection to the database to succeed.
	 */
	async wait(): Promise<void> {
		if (!this.#ws) {
			throw new Error(
				"You have to call .connect before any other method!",
			);
		}
		await this.#ws.ready;
		await this.#attempted!;
	}

	/**
	 * Closes the persistent connection to the database.
	 */
	close(): void {
		this.#ws.close();
	}

	// --------------------------------------------------
	/**
	 * Ping SurrealDB instance
	 */
	async ping(): Promise<void> {
		await this.#send("ping");
	}

	/**
	 * Switch to a specific namespace and database.
	 * @param ns - Switches to a specific namespace.
	 * @param db - Switches to a specific database.
	 */
	async use(ns: string, db: string): Promise<void> {
		const res = await this.#send("use", [ns, db]);

		this.#outputHandlerError(res);

		return res.result;
	}

	/**
	 * Retreive info about the current Surreal instance
	 * @return Returns nothing!
	 */
	async info(): Promise<void> {
		const res = await this.#send("info");

		this.#outputHandlerError(res);

		return res.result;
	}

	/**
	 * Signs up to a specific authentication scope.
	 * @param vars - Variables used in a signup query.
	 * @return The authenication token.
	 */
	async signup(vars: Auth): Promise<string> {
		const res = await this.#send("signup", [vars]);

		this.#outputHandlerError(res, AuthenticationError as typeof Error);

		this.#token = res.result;
		return res.result;
	}

	/**
	 * Signs in to a specific authentication scope.
	 * @param vars - Variables used in a signin query.
	 * @return The authenication token.
	 */
	async signin(vars: Auth): Promise<string> {
		const res = await this.#send("signin", [vars]);

		this.#outputHandlerError(res, AuthenticationError as typeof Error);

		this.#token = res.result;
		return res.result;
	}

	/**
	 * Invalidates the authentication for the current connection.
	 */
	async invalidate(): Promise<void> {
		const res = await this.#send("invalidate");

		this.#outputHandlerError(res, AuthenticationError as typeof Error);

		return res.result;
	}

	/**
	 * Authenticates the current connection with a JWT token.
	 * @param token - The JWT authentication token.
	 */
	async authenticate(token: string): Promise<void> {
    this.#token = token;
		const res = await this.#send("authenticate", [token], false);

		this.#outputHandlerError(res, AuthenticationError as typeof Error);

		return res.result;
	}

	// --------------------------------------------------
	async live(table: string): Promise<string> {
		const res = await this.#send("live", [table]);

		this.#outputHandlerError(res);

		return res.result;
	}

	/**
	 * Kill a specific query.
	 * @param query - The query to kill.
	 */
	async kill(query: string): Promise<void> {
		const res = await this.#send("kill", [query]);

		this.#outputHandlerError(res);

		return res.result;
	}

	/**
	 * Switch to a specific namespace and database.
	 * @param key - Specifies the name of the variable.
	 * @param val - Assigns the value to the variable name.
	 */
	async let(key: string, val: unknown): Promise<string> {
		const res = await this.#send("let", [key, val]);

		this.#outputHandlerError(res);

		return res.result;
	}

	/**
	 * Runs a set of SurrealQL statements against the database.
	 * @param query - Specifies the SurrealQL statements.
	 * @param vars - Assigns variables which can be used in the query.
	 */
	async query<T = Result[]>(
		query: string,
		vars?: Record<string, unknown>,
	): Promise<T> {
		const res = await this.#send("query", [query, vars]);

		this.#outputHandlerError(res);

		return res.result;
	}

	/**
	 * Selects all records in a table, or a specific record, from the database.
	 * @param thing - The table name or a record ID to select.
	 */
	async select<T>(thing: string): Promise<T[]> {
		const res = await this.#send("select", [thing]);

		return this.#outputHandlerB(
			res,
			thing,
			RecordError as typeof Error,
			`Record not found: ${thing}`,
		);
	}

	/**
	 * Creates a record in the database.
	 * @param thing - The table name or the specific record ID to create.
	 * @param data - The document / record data to insert.
	 */
	async create<T extends Record<string, unknown>>(
		thing: string,
		data?: T,
	): Promise<T & { id: string }> {
		const res = await this.#send("create", [thing, data]);

		this.#outputHandlerError(res);

		return this.#outputHandlerA(
			res,
			PermissionError as typeof Error,
			`Unable to create record: ${thing}`,
		);
	}

	/**
	 * Updates all records in a table, or a specific record, in the database.
	 *
	 * ***NOTE: This function replaces the current document / record data with the specified data.***
	 * @param thing - The table name or the specific record ID to update.
	 * @param data - The document / record data to insert.
	 */
	async update<T extends Record<string, unknown>>(
		thing: string,
		data?: T,
	): Promise<T & { id: string }> {
		const res = await this.#send("update", [thing, data]);

		return this.#outputHandlerB(
			res,
			thing,
			PermissionError as typeof Error,
			`Unable to update record: ${thing}`,
		);
	}

	/**
	 * Modifies all records in a table, or a specific record, in the database.
	 *
	 * ***NOTE: This function merges the current document / record data with the specified data.***
	 * @param thing - The table name or the specific record ID to change.
	 * @param data - The document / record data to insert.
	 */
	async change<
		T extends Record<string, unknown>,
		U extends Record<string, unknown> = T,
	>(
		thing: string,
		data?: Partial<T> & U,
	): Promise<(T & U & { id: string }) | (T & U & { id: string })[]> {
		const res = await this.#send("change", [thing, data]);

		return this.#outputHandlerB(
			res,
			thing,
			PermissionError as typeof Error,
			`Unable to update record: ${thing}`,
		);
	}

	/**
	 * Applies JSON Patch changes to all records, or a specific record, in the database.
	 *
	 * ***NOTE: This function patches the current document / record data with the specified JSON Patch data.***
	 * @param thing - The table name or the specific record ID to modify.
	 * @param data - The JSON Patch data with which to modify the records.
	 */
	async modify(thing: string, data?: Patch[]): Promise<Patch[]> {
		const res = await this.#send("modify", [thing, data]);

		return this.#outputHandlerB(
			res,
			thing,
			PermissionError as typeof Error,
			`Unable to update record: ${thing}`,
		);
	}

	/**
	 * Deletes all records in a table, or a specific record, from the database.
	 * @param thing - The table name or a record ID to select.
	 */
	async delete(thing: string): Promise<void> {
		const res = await this.#send("delete", [thing]);

		this.#outputHandlerError(res);
		return;
	}

	// --------------------------------------------------
	// Private methods
	// --------------------------------------------------
	#init(): void {
		this.#attempted = Promise.resolve().then(async () => {
			if(!this.#token) {
				return
			}
			try {
				await this.authenticate(this.#token)
			} catch (_) {
				// ignore Errors
			}
		})
	}

	async #send(method: string, params: unknown[] = [], wait = true) {
		const id = guid();
		if(wait) {
			await this.wait();
		} else {
			await this.#ws.ready;
		}
		this.#ws.send(JSON.stringify({
			id: id,
			method: method,
			params: params,
		}));
		const [res] = await this.nextEvent(id);
		return res;
	}

	#outputHandlerA<T>(
		res: Result<T>,
		Err: typeof Error,
		errormessage: string,
	) {
		if (Array.isArray(res.result) && res.result.length) {
			return res.result[0];
		}
		throw new Err(errormessage);
	}

	#outputHandlerB<T>(
		res: Result<T>,
		id: string,
		Err: typeof Error,
		errormessage: string,
	) {
		this.#outputHandlerError(res);
		if (typeof id === "string" && id.includes(":")) {
			this.#outputHandlerA(res, Err, errormessage);
		} else {
			return res.result;
		}
	}

	#outputHandlerError<T>(res: Result<T>, Err: typeof Error = Error) {
		if (res.error) {
			throw new Err(res.error.message);
		}
	}
}
