// ask-user: lets the agent ask you a question and wait for the answer (same tool name as the built-in, so it replaces it).
export default (pi: any) => {
	const T = pi.Type;
	const DESCRIPTION =
		"Ask the user a question and wait for the answer. Use it only when a requirement is genuinely ambiguous or a decision is hard to undo; " +
		"for minor details, make a reasonable assumption and continue. Offer `options` when the choices are known, " +
		"and set `recommended` to the option you suggest (it is highlighted for the user).";
	const options = (extra: Record<string, unknown> = {}) => T.Optional(T.Array(T.String({ minLength: 1, maxLength: 200 }), { minItems: 2, maxItems: 8, ...extra }));
	const recommended = T.Optional(T.String({ minLength: 1, maxLength: 200, description: "The option you recommend; must be one of `options`" }));

	pi.registerTool({
		name: "ask_user",
		label: "Ask user",
		description: DESCRIPTION,
		parameters: T.Object({
			question: T.Optional(T.String({ minLength: 1, maxLength: 2000, description: "One clear question. Omit when using `questions`" })),
			options: options({ description: "Suggested answers" }),
			recommended,
			allowFreeText: T.Optional(T.Boolean({ description: "Let the user type something other than the options. Default true" })),
			questions: T.Optional(
				T.Array(
					T.Object({
						question: T.String({ minLength: 1, maxLength: 2000 }),
						options: options(),
						recommended,
						allowFreeText: T.Optional(T.Boolean()),
					}),
					{ minItems: 2, maxItems: 8, description: "Ask several independent questions at once instead of one by one. The user sees them as tabs and can revise any answer before sending" },
				),
			),
		}),
		async execute(id: string, p: any, ctx: any, signal?: AbortSignal) {
			const rec = (o?: string[], r?: string) => (r && o?.includes(r) ? { recommended: r } : {});
			const items = p.questions?.map((q: any) => ({ question: q.question, options: q.options, ...rec(q.options, q.recommended), allowFreeText: q.allowFreeText ?? true }));
			if (!items?.length && !p.question) throw new Error("ask_user needs `question` or `questions`");
			const first = items?.[0] ?? { question: p.question, options: p.options, ...rec(p.options, p.recommended), allowFreeText: p.allowFreeText ?? true };
			const answer = await ctx.ask(id, { ...first, ...(items?.length ? { items } : {}) }, signal);
			return { content: [{ type: "text", text: answer }], details: { question: first.question, answer } };
		},
	});
};
