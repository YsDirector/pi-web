/**
 * Batch questionnaire dialog for the __piBatchAsk__ envelope protocol.
 *
 * Fork-only component (upstream has no equivalent). Renders one tab per
 * question (select/confirm/input/editor), an optional Review tab, and replies
 * with { value: JSON.stringify({ answers }) }.
 *
 * Collapsible like the upstream ExtensionDialog (v0.9.0): a pill in the
 * top-left corner keeps the request alive without blocking the editor, and a
 * chevron in the header re-collapses it.
 */
import { useState } from "react";
import { useI18n } from "@/hooks/useI18n";
import { isAnswered, type BatchAskAnswer, type BatchAskDialogRequest, type BatchAskEnvelope } from "@/lib/batch-ask";

export function BatchAskDialog({
	request,
	envelope,
	onRespond,
}: {
	request: BatchAskDialogRequest;
	envelope: BatchAskEnvelope;
	onRespond: (request: BatchAskDialogRequest, response: { value: string } | { confirmed: boolean } | { cancelled: true }) => void;
}) {
	const { t } = useI18n();
	const questions = envelope.questions;
	const reviewIndex = questions.length;
	const [activeTab, setActiveTab] = useState(0);
	const [collapsed, setCollapsed] = useState(false);
	const [answers, setAnswers] = useState<(BatchAskAnswer | null)[]>(() => questions.map(() => null));
	const [customMode, setCustomMode] = useState<boolean[]>(() => questions.map(() => false));
	const [customTexts, setCustomTexts] = useState<string[]>(() => questions.map(() => ""));

	const answeredCount = answers.filter(isAnswered).length;
	const allAnswered = answeredCount === questions.length;
	// review 模式下必须切到审阅页才能提交（防误提交）
	const canSubmit = allAnswered && (!envelope.review || activeTab === reviewIndex);

	const setAnswer = (qi: number, a: BatchAskAnswer) => {
		setAnswers((prev) => prev.map((x, i) => (i === qi ? a : x)));
	};

	const submit = () => {
		const clean = questions
			.map((q, i) => {
				const a = answers[i];
				if (!isAnswered(a)) return null;
				return { ...a, id: q.id, type: q.type };
			})
			.filter(Boolean);
		onRespond(request, { value: JSON.stringify({ answers: clean }) });
	};

	const q = activeTab < questions.length ? questions[activeTab] : null;

	// 折叠 pill 的摘要行：当前激活问题的首行（40 字截断）
	const currentPrompt = q?.question.split("\n")[0] ?? "";
	const pillSummary = currentPrompt.length > 40 ? `${currentPrompt.slice(0, 40)}…` : currentPrompt;

	const tabStyle = (active: boolean, done: boolean): React.CSSProperties => ({
		padding: "6px 12px",
		borderRadius: 6,
		border: active ? "1px solid var(--accent)" : "1px solid var(--border)",
		background: active ? "var(--accent)" : "var(--bg-panel)",
		color: active ? "#fff" : done ? "var(--text)" : "var(--text-muted)",
		cursor: "pointer",
		fontSize: 12,
		whiteSpace: "nowrap",
	});

	return (
		<div
			onKeyDown={(event) => {
				// Escape 取消整个问卷；composing（中文输入法）状态下不误触
				if (event.key !== "Escape" || event.nativeEvent.isComposing) return;
				event.preventDefault();
				event.stopPropagation();
				onRespond(request, { cancelled: true });
			}}
			style={{
				position: "absolute",
				inset: 0,
				zIndex: 90,
				display: "flex",
				alignItems: collapsed ? "flex-start" : "center",
				justifyContent: "center",
				padding: 20,
				pointerEvents: "none",
			}}
		>
			{collapsed ? (
				<button
					type="button"
					onClick={() => setCollapsed(false)}
					aria-expanded={false}
					style={{
						pointerEvents: "auto",
						display: "flex",
						alignItems: "center",
						gap: 10,
						maxWidth: "min(760px, 100%)",
						width: "100%",
						padding: "10px 12px",
						border: "1px solid var(--border)",
						borderRadius: 8,
						background: "var(--bg)",
						boxShadow: "0 12px 32px rgba(0,0,0,0.18)",
						color: "var(--text)",
						cursor: "pointer",
						textAlign: "left",
					}}
				>
					<span style={{ fontSize: 11, fontWeight: 650, color: "var(--accent)", flexShrink: 0 }}>
						{t("chat.batchAskTitle")}
					</span>
					<span style={{ fontSize: 12, color: allAnswered ? "var(--text)" : "var(--text-muted)", fontFamily: "var(--font-mono)", flexShrink: 0 }}>
						{answeredCount}/{questions.length}
					</span>
					<span style={{ fontSize: 13, fontWeight: 600, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap", flex: 1, minWidth: 0 }}>
						{pillSummary}
					</span>
					<span style={{ fontSize: 12, color: allAnswered ? "var(--accent)" : "var(--text-muted)", flexShrink: 0 }}>
						{allAnswered ? t("chat.reviewTab") : t("chat.extensionExpand")}
					</span>
				</button>
			) : (
			<div
				role="dialog"
				aria-modal="true"
				style={{
					pointerEvents: "auto",
					width: "min(760px, 100%)",
					maxHeight: "min(720px, calc(100vh - 40px))",
					display: "flex",
					flexDirection: "column",
					border: "1px solid var(--border)",
					borderRadius: 8,
					background: "var(--bg)",
					boxShadow: "0 20px 60px rgba(0,0,0,0.28)",
					overflow: "hidden",
				}}
			>
				{/* header */}
				<div
					style={{
						display: "flex",
						alignItems: "center",
						justifyContent: "space-between",
						gap: 10,
						padding: "12px 14px",
						borderBottom: "1px solid var(--border)",
						flexShrink: 0,
					}}
				>
					<div style={{ color: "var(--text)", fontSize: 14, fontWeight: 650 }}>{t("chat.batchAskTitle")}</div>
					<div style={{ display: "flex", alignItems: "center", gap: 10 }}>
						<div style={{ color: "var(--text-dim)", fontSize: 11, fontFamily: "var(--font-mono)" }}>
							{answeredCount}/{questions.length} {t("chat.answered")}
						</div>
						<button
							type="button"
							onClick={() => setCollapsed(true)}
							aria-expanded={true}
							title={t("chat.extensionCollapse")}
							aria-label={t("chat.extensionCollapse")}
							style={{
								display: "grid",
								placeItems: "center",
								width: 28,
								height: 28,
								borderRadius: 6,
								border: "1px solid var(--border)",
								background: "var(--bg-panel)",
								color: "var(--text-muted)",
								cursor: "pointer",
								flexShrink: 0,
							}}
						>
							<svg width="10" height="10" viewBox="0 0 10 10" fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
								<polyline points="2 3.5 5 6.5 8 3.5" />
							</svg>
						</button>
					</div>
				</div>

				{/* tabs */}
				<div
					style={{
						display: "flex",
						gap: 6,
						padding: "10px 14px 0",
						borderBottom: "1px solid var(--border)",
						overflowX: "auto",
						flexShrink: 0,
					}}
				>
					{questions.map((qq, i) => (
						<button key={qq.id} onClick={() => setActiveTab(i)} style={tabStyle(activeTab === i, isAnswered(answers[i]))}>
							Q{i + 1}
						</button>
					))}
					{envelope.review && (
						<button onClick={() => setActiveTab(reviewIndex)} style={tabStyle(activeTab === reviewIndex, allAnswered)}>
							{t("chat.reviewTab")}
						</button>
					)}
				</div>

				{/* body */}
				<div style={{ flex: 1, overflowY: "auto", padding: 14 }}>
					{q ? (
						<div key={q.id}>
							<div style={{ color: "var(--text)", fontSize: 14, fontWeight: 600, marginBottom: 12, whiteSpace: "pre-wrap" }}>
								{q.question}
							</div>
							{q.type === "select" && (
								<div style={{ display: "grid", gap: 8 }}>
									{(q.options ?? []).map((opt) => {
										const chosen = isAnswered(answers[activeTab]) && answers[activeTab]?.value === opt.value;
										return (
											<button
												key={opt.value}
												onClick={() => setAnswer(activeTab, { id: q.id, type: "select", value: opt.value, label: opt.label, wasCustom: false })}
												style={{
													width: "100%",
													padding: "9px 10px",
													borderRadius: 7,
													border: chosen ? "1px solid var(--accent)" : "1px solid var(--border)",
													background: "var(--bg-panel)",
													color: "var(--text)",
													cursor: "pointer",
													textAlign: "left",
													fontSize: 13,
												}}
											>
												{opt.description ? (
													<>
														<span style={{ fontWeight: 550 }}>{opt.label}</span>
														<span style={{ color: "var(--text-muted)", marginLeft: 6, fontSize: 12 }}>— {opt.description}</span>
													</>
												) : (
													opt.label
												)}
											</button>
										);
									})}
									{q.allowOther !== false && !customMode[activeTab] && (
										<button
											onClick={() => setCustomMode((prev) => prev.map((x, i) => (i === activeTab ? true : x)))}
											style={{
												width: "100%",
												padding: "9px 10px",
												borderRadius: 7,
												border: "1px dashed var(--border)",
												background: "var(--bg-panel)",
												color: "var(--text-muted)",
												cursor: "pointer",
												textAlign: "left",
												fontSize: 13,
											}}
										>
											{t("chat.customInput")}
										</button>
									)}
									{q.allowOther !== false && customMode[activeTab] && (
										<div style={{ display: "flex", gap: 8 }}>
											<input
												autoFocus
												value={customTexts[activeTab]}
												placeholder={t("chat.customInput")}
												onChange={(e) =>
													setCustomTexts((prev) => prev.map((x, i) => (i === activeTab ? e.target.value : x)))
												}
												onKeyDown={(e) => {
													if (e.key === "Enter") {
														const v = customTexts[activeTab].trim();
														if (v) setAnswer(activeTab, { id: q.id, type: "select", value: v, label: v, wasCustom: true });
													}
													if (e.key === "Escape") setCustomMode((prev) => prev.map((x, i) => (i === activeTab ? false : x)));
												}}
												style={{
													flex: 1,
													padding: "9px 10px",
													borderRadius: 7,
													border: "1px solid var(--border)",
													background: "var(--bg-panel)",
													color: "var(--text)",
													outline: "none",
													fontSize: 13,
												}}
											/>
											<button
												onClick={() => {
													const v = customTexts[activeTab].trim();
													if (v) setAnswer(activeTab, { id: q.id, type: "select", value: v, label: v, wasCustom: true });
												}}
												style={{
													padding: "9px 12px",
													borderRadius: 7,
													border: "1px solid var(--accent)",
													background: "var(--accent)",
													color: "#fff",
													cursor: "pointer",
													fontSize: 13,
												}}
											>
												{t("chat.confirm")}
											</button>
										</div>
									)}
								</div>
							)}
							{q.type === "confirm" && (
								<div style={{ display: "flex", gap: 8 }}>
									{[true, false].map((yes) => {
										const chosen = isAnswered(answers[activeTab]) && answers[activeTab]?.value === yes;
										return (
											<button
												key={String(yes)}
												onClick={() => setAnswer(activeTab, { id: q.id, type: "confirm", value: yes, label: yes ? t("chat.yes") : t("chat.no") })}
												style={{
													padding: "9px 16px",
													borderRadius: 7,
													border: chosen ? "1px solid var(--accent)" : "1px solid var(--border)",
													background: "var(--bg-panel)",
													color: "var(--text)",
													cursor: "pointer",
													fontSize: 13,
												}}
											>
												{yes ? t("chat.yes") : t("chat.no")}
											</button>
										);
									})}
								</div>
							)}
							{q.type === "editor" && (
								<textarea
									autoFocus
									value={isAnswered(answers[activeTab]) ? String(answers[activeTab]?.value) : q.prefill ?? ""}
									onChange={(e) => setAnswer(activeTab, { id: q.id, type: "editor", value: e.target.value })}
									placeholder={q.placeholder}
									style={{
										width: "100%",
										minHeight: 200,
										padding: 10,
										borderRadius: 7,
										border: "1px solid var(--border)",
										background: "var(--bg-panel)",
										color: "var(--text)",
										outline: "none",
										resize: "vertical",
										fontSize: 13,
										lineHeight: 1.55,
										fontFamily: "var(--font-mono)",
									}}
								/>
							)}
							{q.type === "input" && (
								<input
									autoFocus
									value={isAnswered(answers[activeTab]) ? String(answers[activeTab]?.value) : ""}
									placeholder={q.placeholder}
									onChange={(e) => setAnswer(activeTab, { id: q.id, type: "input", value: e.target.value })}
									onKeyDown={(e) => {
										if (e.key === "Enter" && isAnswered(answers[activeTab])) setActiveTab(Math.min(activeTab + 1, reviewIndex));
									}}
									style={{
										width: "100%",
										padding: "9px 10px",
										borderRadius: 7,
										border: "1px solid var(--border)",
										background: "var(--bg-panel)",
										color: "var(--text)",
										outline: "none",
										fontSize: 13,
									}}
								/>
							)}
							{isAnswered(answers[activeTab]) && (
								<button
									onClick={() => setActiveTab(Math.min(activeTab + 1, reviewIndex))}
									style={{
										marginTop: 12,
										padding: "7px 12px",
										borderRadius: 6,
										border: "1px solid var(--border)",
										background: "var(--bg-panel)",
										color: "var(--text)",
										cursor: "pointer",
										fontSize: 12,
									}}
								>
									{t("chat.submit")} →
								</button>
							)}
						</div>
					) : (
						<div style={{ display: "grid", gap: 12 }}>
							{questions.map((qq, i) => {
								const a = answers[i];
								return (
									<div
										key={qq.id}
										style={{ padding: 10, borderRadius: 7, border: "1px solid var(--border)", background: "var(--bg-panel)" }}
									>
										<div style={{ color: "var(--text)", fontSize: 13, marginBottom: 4 }}>
											<b>Q{i + 1}</b> · {qq.question}
										</div>
										<div style={{ color: isAnswered(a) ? "var(--text)" : "var(--text-muted)", fontSize: 13, whiteSpace: "pre-wrap" }}>
											{isAnswered(a)
												? `${a?.label ?? a?.value}${a?.wasCustom ? ` (${t("chat.customInput")})` : ""}`
												: `— ${t("chat.unanswered")}`}
										</div>
									</div>
								);
							})}
						</div>
					)}
				</div>

				{/* footer */}
				<div
					style={{
						display: "flex",
						alignItems: "center",
						justifyContent: "space-between",
						gap: 8,
						padding: "10px 14px",
						borderTop: "1px solid var(--border)",
						background: "var(--bg-panel)",
						flexShrink: 0,
					}}
				>
					<button
						onClick={() => onRespond(request, { cancelled: true })}
						style={{
							padding: "6px 10px",
							borderRadius: 6,
							border: "1px solid var(--border)",
							background: "var(--bg)",
							color: "var(--text-muted)",
							cursor: "pointer",
							fontSize: 12,
						}}
					>
						{t("chat.cancel")}
					</button>
					<div style={{ color: "var(--text-dim)", fontSize: 11 }}>
						{allAnswered ? t("chat.allAnswered") : t("chat.notAllAnswered")}
					</div>
					<button
						onClick={submit}
						disabled={!canSubmit}
						style={{
							padding: "6px 14px",
							borderRadius: 6,
							border: "1px solid var(--accent)",
							background: "var(--accent)",
							color: "#fff",
							cursor: canSubmit ? "pointer" : "not-allowed",
							opacity: canSubmit ? 1 : 0.5,
							fontSize: 12,
						}}
					>
						{t("chat.submit")}
					</button>
				</div>
			</div>
			)}
		</div>
	);
}
