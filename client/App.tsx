import { useCallback, useEffect, useRef, useState } from 'react';

type Job = {
	id: string;
	status: 'queued' | 'downloading' | 'extracting' | 'done' | 'error';
	progress: number;
	totalFrames: number;
	error?: string;
	source: string;
	width?: number;
	height?: number;
	fps?: number;
	duration?: number;
};

type Frame = {
	index: number;
	name: string;
	url: string;
};

type FramesPayload = {
	status: string;
	totalFrames: number;
	frames: Frame[];
	meta?: {
		source: string;
		width?: number;
		height?: number;
		fps?: number;
		duration?: number;
	};
};

function formatTime(seconds: number) {
	if (!Number.isFinite(seconds) || seconds < 0) return '—';
	const m = Math.floor(seconds / 60);
	const s = Math.floor(seconds % 60);
	return `${m}:${String(s).padStart(2, '0')}`;
}

function statusLabel(status: Job['status']) {
	switch (status) {
		case 'queued':
			return 'Queued…';
		case 'downloading':
			return 'Downloading video…';
		case 'extracting':
			return 'Extracting frames…';
		case 'done':
			return 'Done';
		case 'error':
			return 'Failed';
	}
}

export default function App() {
	const [url, setUrl] = useState('');
	const [every, setEvery] = useState('1');
	const [dragging, setDragging] = useState(false);
	const [busy, setBusy] = useState(false);
	const [job, setJob] = useState<Job | null>(null);
	const [frames, setFrames] = useState<Frame[]>([]);
	const [meta, setMeta] = useState<FramesPayload['meta']>();
	const [index, setIndex] = useState(0);
	const [error, setError] = useState<string | null>(null);
	const [rangeFrom, setRangeFrom] = useState(1);
	const [rangeTo, setRangeTo] = useState(1);
	const [rangeBusy, setRangeBusy] = useState(false);
	const fileRef = useRef<HTMLInputElement>(null);
	const stripRef = useRef<HTMLDivElement>(null);
	const activeThumbRef = useRef<HTMLButtonElement>(null);

	const selected = frames[index];

	const reset = useCallback(async () => {
		if (job?.id) {
			try {
				await fetch(`/api/jobs/${job.id}`, { method: 'DELETE' });
			} catch {
				/* ignore */
			}
		}
		setJob(null);
		setFrames([]);
		setMeta(undefined);
		setIndex(0);
		setRangeFrom(1);
		setRangeTo(1);
		setRangeBusy(false);
		setError(null);
		setBusy(false);
		setUrl('');
	}, [job?.id]);

	const startParse = useCallback(
		async (opts: { file?: File; url?: string }) => {
			setError(null);
			setFrames([]);
			setMeta(undefined);
			setIndex(0);
			setBusy(true);
			setJob(null);

			try {
				const form = new FormData();
				if (opts.file) form.append('file', opts.file);
				if (opts.url) form.append('url', opts.url);
				form.append('every', every);

				const res = await fetch('/api/parse', { method: 'POST', body: form });
				const data = await res.json();
				if (!res.ok || data.error) {
					throw new Error(data.error || 'Failed to start parse');
				}
				setJob({
					id: data.id,
					status: data.status,
					progress: 0,
					totalFrames: 0,
					source: opts.file?.name || opts.url || '',
				});
			} catch (e) {
				setError(e instanceof Error ? e.message : String(e));
				setBusy(false);
			}
		},
		[every],
	);

	useEffect(() => {
		if (!job?.id) return;

		let cancelled = false;
		let intervalId = 0;

		const stop = () => {
			if (intervalId) window.clearInterval(intervalId);
			intervalId = 0;
		};

		const tick = async () => {
			try {
				const res = await fetch(`/api/jobs/${job.id}`);
				const data = (await res.json()) as Job & { error?: string };
				if (cancelled) return;
				if (!res.ok) {
					stop();
					setError('Job lost');
					setBusy(false);
					return;
				}
				setJob(data);
				if (data.status === 'error') {
					stop();
					setError(data.error || 'Extraction failed');
					setBusy(false);
					return;
				}
				if (data.status === 'done') {
					stop();
					const fr = await fetch(`/api/jobs/${job.id}/frames`);
					const payload = (await fr.json()) as FramesPayload;
					if (cancelled) return;
					setFrames(payload.frames ?? []);
					setMeta(payload.meta);
					setIndex(0);
					const total = payload.frames?.length ?? 0;
					setRangeFrom(1);
					setRangeTo(Math.max(1, total));
					setBusy(false);
				}
			} catch (e) {
				if (!cancelled) {
					stop();
					setError(e instanceof Error ? e.message : String(e));
					setBusy(false);
				}
			}
		};

		intervalId = window.setInterval(tick, 400);
		void tick();
		return () => {
			cancelled = true;
			stop();
		};
	}, [job?.id]);

	useEffect(() => {
		activeThumbRef.current?.scrollIntoView({
			behavior: 'smooth',
			inline: 'center',
			block: 'nearest',
		});
	}, [index]);

	useEffect(() => {
		const onKey = (e: KeyboardEvent) => {
			if (!frames.length) return;
			const t = e.target as HTMLElement | null;
			if (t && (t.tagName === 'INPUT' || t.tagName === 'SELECT' || t.tagName === 'TEXTAREA')) {
				return;
			}
			if (e.key === 'ArrowRight' || e.key === 'j' || e.key === ' ') {
				e.preventDefault();
				setIndex((i) => Math.min(frames.length - 1, i + 1));
			} else if (e.key === 'ArrowLeft' || e.key === 'k') {
				e.preventDefault();
				setIndex((i) => Math.max(0, i - 1));
			} else if (e.key === 'Home') {
				e.preventDefault();
				setIndex(0);
			} else if (e.key === 'End') {
				e.preventDefault();
				setIndex(frames.length - 1);
			}
		};
		window.addEventListener('keydown', onKey);
		return () => window.removeEventListener('keydown', onKey);
	}, [frames.length]);

	useEffect(() => {
		const onPaste = (e: ClipboardEvent) => {
			if (busy || frames.length) return;
			const items = e.clipboardData?.items;
			if (!items) return;
			for (const item of items) {
				if (item.kind === 'file' && item.type.startsWith('video/')) {
					e.preventDefault();
					const file = item.getAsFile();
					if (file) void startParse({ file });
					return;
				}
			}
			const text = e.clipboardData?.getData('text')?.trim();
			if (text && /^https?:\/\//i.test(text)) {
				e.preventDefault();
				setUrl(text);
				void startParse({ url: text });
			}
		};
		window.addEventListener('paste', onPaste);
		return () => window.removeEventListener('paste', onPaste);
	}, [busy, frames.length, startParse]);

	const onDrop = (e: React.DragEvent) => {
		e.preventDefault();
		setDragging(false);
		if (busy) return;
		const file = e.dataTransfer.files?.[0];
		if (file && file.type.startsWith('video/')) {
			void startParse({ file });
			return;
		}
		const uri = e.dataTransfer.getData('text/uri-list') || e.dataTransfer.getData('text');
		if (uri && /^https?:\/\//i.test(uri.trim())) {
			setUrl(uri.trim());
			void startParse({ url: uri.trim() });
		}
	};

	const downloadFrame = async () => {
		if (!selected) return;
		const res = await fetch(selected.url);
		const blob = await res.blob();
		const a = document.createElement('a');
		a.href = URL.createObjectURL(blob);
		a.download = selected.name;
		a.click();
		URL.revokeObjectURL(a.href);
	};

	const downloadRange = async () => {
		if (!job?.id || !frames.length) return;
		let from = Math.trunc(rangeFrom) || 1;
		let to = Math.trunc(rangeTo) || frames.length;
		from = Math.min(Math.max(1, from), frames.length);
		to = Math.min(Math.max(1, to), frames.length);
		if (from > to) [from, to] = [to, from];
		setRangeFrom(from);
		setRangeTo(to);
		setRangeBusy(true);
		setError(null);
		try {
			const res = await fetch(`/api/jobs/${job.id}/export?from=${from}&to=${to}`);
			if (!res.ok) {
				const data = (await res.json().catch(() => null)) as { error?: string } | null;
				throw new Error(data?.error || `Export failed (${res.status})`);
			}
			const blob = await res.blob();
			const a = document.createElement('a');
			a.href = URL.createObjectURL(blob);
			a.download = `frames_${from}-${to}.zip`;
			a.click();
			URL.revokeObjectURL(a.href);
		} catch (e) {
			setError(e instanceof Error ? e.message : String(e));
		} finally {
			setRangeBusy(false);
		}
	};

	const clampRange = (value: number) => Math.min(Math.max(1, value), Math.max(1, frames.length));
	const rangeCount = Math.max(0, Math.abs(Math.trunc(rangeTo) - Math.trunc(rangeFrom)) + 1);

	const fps = meta?.fps ?? job?.fps;
	const timestamp = fps && frames.length ? formatTime(index / fps) : '—';

	const progressPct =
		job?.status === 'extracting' && job.progress > 0
			? Math.min(99, job.progress)
			: job?.status === 'downloading'
				? 15
				: job?.status === 'queued'
					? 5
					: 0;

	return (
		<div className="app">
			<div className="shell">
				<header className="topbar">
					<h1 className="brand">
						Frame<span>forge</span>
					</h1>
					<p className="hint">Drop, paste, or URL → every frame, navigable</p>
				</header>

				{!frames.length && !busy && (
					<section
						className={`dropzone${dragging ? ' over' : ''}`}
						onDragOver={(e) => {
							e.preventDefault();
							setDragging(true);
						}}
						onDragLeave={() => setDragging(false)}
						onDrop={onDrop}
					>
						<div className="drop-inner">
							<h2 className="drop-title">Feed it a video</h2>
							<p className="drop-sub">
								Drop a file, paste a video or URL (<span className="kbd">⌘V</span>), or pick one below. Frames come out
								via ffmpeg.
							</p>
							<div className="url-row">
								<input
									type="url"
									placeholder="https://…/clip.mp4 or /Users/…/video.mp4"
									value={url}
									onChange={(e) => setUrl(e.target.value)}
									onKeyDown={(e) => {
										if (e.key === 'Enter' && url.trim()) {
											void startParse({ url: url.trim() });
										}
									}}
								/>
								<button
									className="btn btn-primary"
									disabled={!url.trim()}
									onClick={() => void startParse({ url: url.trim() })}
								>
									Parse URL
								</button>
							</div>
							<div className="controls">
								<input
									ref={fileRef}
									type="file"
									accept="video/*"
									hidden
									onChange={(e) => {
										const f = e.target.files?.[0];
										if (f) void startParse({ file: f });
										e.target.value = '';
									}}
								/>
								<button className="btn btn-ghost" onClick={() => fileRef.current?.click()}>
									Choose file
								</button>
								<label className="field">
									Sample
									<select value={every} onChange={(e) => setEvery(e.target.value)}>
										<option value="1">every frame</option>
										<option value="2">every 2nd</option>
										<option value="5">every 5th</option>
										<option value="10">every 10th</option>
										<option value="30">every 30th</option>
									</select>
								</label>
							</div>
						</div>
					</section>
				)}

				{busy && job && (
					<section className="status">
						<div className="spinner" />
						<p className="hint">{statusLabel(job.status)}</p>
						{job.status === 'extracting' && job.progress > 0 && (
							<p className="hint">{job.progress.toLocaleString()} frames written…</p>
						)}
						<div className="progress-bar">
							<i style={{ width: `${progressPct}%` }} />
						</div>
						<button className="btn btn-ghost btn-danger" onClick={() => void reset()}>
							Cancel
						</button>
					</section>
				)}

				{error && <p className="err">{error}</p>}

				{frames.length > 0 && selected && (
					<section className="viewer">
						<div className="meta-row">
							<div className="meta-chips">
								<span className="chip">{frames.length.toLocaleString()} frames</span>
								{meta?.width && meta?.height && (
									<span className="chip">
										{meta.width}×{meta.height}
									</span>
								)}
								{fps != null && <span className="chip">{fps.toFixed(2)} fps</span>}
								{meta?.duration != null && <span className="chip">{formatTime(meta.duration)}</span>}
								<span className="chip" title={meta?.source}>
									{meta?.source && meta.source.length > 48 ? `${meta.source.slice(0, 48)}…` : meta?.source}
								</span>
							</div>
							<button className="btn btn-ghost btn-danger" onClick={() => void reset()}>
								New video
							</button>
						</div>

						<div className="stage">
							<img src={selected.url} alt={`Frame ${index + 1}`} />
							<div className="nav-float">
								<button
									className="btn"
									disabled={index <= 0}
									onClick={() => setIndex((i) => Math.max(0, i - 1))}
									aria-label="Previous frame"
								>
									‹
								</button>
								<button
									className="btn"
									disabled={index >= frames.length - 1}
									onClick={() => setIndex((i) => Math.min(frames.length - 1, i + 1))}
									aria-label="Next frame"
								>
									›
								</button>
							</div>
							<div className="frame-label">
								#{index + 1} / {frames.length} · {timestamp}
							</div>
						</div>

						<div className="toolbar">
							<button className="btn btn-ghost" disabled={index <= 0} onClick={() => setIndex(0)}>
								First
							</button>
							<button
								className="btn btn-ghost"
								disabled={index <= 0}
								onClick={() => setIndex((i) => Math.max(0, i - 1))}
							>
								Prev
							</button>
							<button
								className="btn btn-primary"
								disabled={index >= frames.length - 1}
								onClick={() => setIndex((i) => Math.min(frames.length - 1, i + 1))}
							>
								Next
							</button>
							<button
								className="btn btn-ghost"
								disabled={index >= frames.length - 1}
								onClick={() => setIndex(frames.length - 1)}
							>
								Last
							</button>
							<button className="btn btn-ghost" onClick={() => void downloadFrame()}>
								Download frame
							</button>
							<label className="field range-field">
								From
								<input
									type="number"
									min={1}
									max={frames.length}
									value={rangeFrom}
									onChange={(e) => setRangeFrom(clampRange(Number(e.target.value) || 1))}
								/>
							</label>
							<label className="field range-field">
								To
								<input
									type="number"
									min={1}
									max={frames.length}
									value={rangeTo}
									onChange={(e) => setRangeTo(clampRange(Number(e.target.value) || 1))}
								/>
							</label>
							<button
								className="btn btn-ghost"
								disabled={rangeBusy || !frames.length}
								onClick={() => void downloadRange()}
								title="Download frames From→To as a zip"
							>
								{rangeBusy ? 'Zipping…' : `Download ${rangeCount} as zip`}
							</button>
							<button
								className="btn btn-ghost"
								type="button"
								onClick={() => {
									setRangeFrom(index + 1);
									setRangeTo(index + 1);
								}}
								title="Set range to current frame"
							>
								Use current
							</button>
							<span className="spacer" />
							<span className="keys">
								<span className="kbd">←</span> <span className="kbd">→</span> or <span className="kbd">K</span>{' '}
								<span className="kbd">J</span> · <span className="kbd">Space</span> next
							</span>
						</div>

						<div className="scrub">
							<input
								type="range"
								min={0}
								max={frames.length - 1}
								value={index}
								onChange={(e) => setIndex(Number(e.target.value))}
							/>
							<div className="strip" ref={stripRef}>
								{frames.map((f, i) => (
									<button
										key={f.name}
										ref={i === index ? activeThumbRef : undefined}
										className={`thumb${i === index ? ' active' : ''}`}
										onClick={() => setIndex(i)}
										title={`Frame ${i + 1}`}
									>
										<img src={f.url} alt="" loading="lazy" />
									</button>
								))}
							</div>
						</div>
					</section>
				)}
			</div>
		</div>
	);
}
