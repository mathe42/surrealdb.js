export interface BasePatch {
	path: string;
}

export interface AddPatch extends BasePatch {
	op: "add";
	// deno-lint-ignore no-explicit-any
	value: any;
}

export interface RemovePatch extends BasePatch {
	op: "remove";
}

export interface ReplacePatch extends BasePatch {
	op: "replace";
	// deno-lint-ignore no-explicit-any
	value: any;
}

export interface ChangePatch extends BasePatch {
	op: "change";
	value: string;
}

export type Patch =
	| AddPatch
	| RemovePatch
	| ReplacePatch
	| ChangePatch;

interface ResultOk<T> {
	result: T;
	error?: never;
}
interface ResultErr {
	result?: never;
	error: Error;
}

export type Result<T = unknown> = ResultOk<T> | ResultErr;

export interface RootAuth {
	user: string;
	pass: string;
}

export interface NamespaceAuth {
	NS: string;
	user: string;
	pass: string;
}

export interface DatabaseAuth {
	NS: string;
	DB: string;
	user: string;
	pass: string;
}

export interface ScopeAuth {
	NS: string;
	DB: string;
	SC: string;
	[key: string]: unknown;
}

export type Auth =
	| RootAuth
	| NamespaceAuth
	| DatabaseAuth
	| ScopeAuth;
