import { spawn } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { copyFile, mkdir, readdir, rm, stat, writeFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { basename, extname, join, resolve } from 'node:path';
import homepage from './client/index.html';

const PORT = Number(process.env.PORT) || 3456;
const ROOT = import.meta.dirname;
const DATA = join(ROOT, 'data');
const UPLOADS = join(DATA, 'uploads');
const FRAMES = join(DATA, 'frames');
const TMP = join(DATA, 'tmp');
const isDev = process.env.NODE_ENV !== 'production';

type JobStatus = 'queued' | 'downloading' | 'extracting' | 'done' | 'error';

type Job = {
	id: string;
	status: JobStatus;
	progress: number;
	totalFrames: number;
	error?: string;
	source: string;
	width?: number;
	height?: number;
	fps?: number;
	duration?: number;
	createdAt: number;
};

const jobs = new Map<string, Job>();

await mkdir(UPLOADS, { recursive: true });
await mkdir(FRAMES, { recursive: true });
await mkdir(TMP, { recursive: true });

function run(
	cmd: string,
	args: string[],
	opts?: { onStderr?: (chunk: string) => void; stdin?: string; cwd?: string },
): Promise<{ code: number; stdout: string; stderr: string }> {
	return new Promise((resolve, reject) => {
		const child = spawn(cmd, args, {
			stdio: [opts?.stdin !== undefined ? 'pipe' : 'ignore', 'pipe', 'pipe'],
			cwd: opts?.cwd,
		});
		let stdout = '';
		let stderr = '';
		child.stdout?.on('data', (buf: Buffer) => {
			stdout += buf.toString();
		});
		child.stderr?.on('data', (buf: Buffer) => {
			const s = buf.toString();
			stderr += s;
			opts?.onStderr?.(s);
		});
		child.on('error', reject);
		child.on('close', (code) => resolve({ code: code ?? 1, stdout, stderr }));
		if (opts?.stdin !== undefined) {
			child.stdin?.write(opts.stdin);
			child.stdin?.end();
		}
	});
}

async function probeVideo(path: string) {
	const { code, stdout, stderr } = await run('ffprobe', [
		'-v',
		'error',
		'-select_streams',
		'v:0',
		'-show_entries',
		'stream=width,height,r_frame_rate,avg_frame_rate,nb_frames,duration',
		'-show_entries',
		'format=duration',
		'-of',
		'json',
		path,
	]);
	if (code !== 0) throw new Error(`ffprobe failed: ${stderr.slice(-400)}`);

	const json = JSON.parse(stdout) as {
		streams?: Array<{
			width?: number;
			height?: number;
			r_frame_rate?: string;
			avg_frame_rate?: string;
			duration?: string;
		}>;
		format?: { duration?: string };
	};
	const stream = json.streams?.[0] ?? {};
	const fmt = json.format ?? {};
	const parseRate = (rate?: string) => {
		if (!rate || rate === '0/0') return 0;
		const [a, b] = rate.split('/').map(Number);
		if (!a || !b) return 0;
		return a / b;
	};
	let fps = parseRate(stream.avg_frame_rate) || parseRate(stream.r_frame_rate) || 30;
	if (fps > 120) fps = parseRate(stream.avg_frame_rate) || 30;
	if (fps > 120) fps = 30;
	const duration = Number(stream.duration || fmt.duration || 0);
	return {
		width: Number(stream.width) || 0,
		height: Number(stream.height) || 0,
		fps,
		duration,
	};
}

async function downloadUrl(url: string, dest: string) {
	const res = await fetch(url);
	if (!res.ok) throw new Error(`Download failed: HTTP ${res.status}`);
	await writeFile(dest, Buffer.from(await res.arrayBuffer()));
}

async function extractFrames(job: Job, videoPath: string, outDir: string, everyN: number) {
	job.status = 'extracting';
	job.progress = 0;

	const fpsFilter = everyN > 1 ? ['-vf', `select=not(mod(n\\,${everyN}))`, '-vsync', 'vfr'] : [];

	let lastFrame = 0;
	const { code, stderr } = await run(
		'ffmpeg',
		['-y', '-i', videoPath, ...fpsFilter, '-q:v', '2', join(outDir, 'frame_%06d.jpg')],
		{
			onStderr: (chunk) => {
				const m = chunk.match(/frame=\s*(\d+)/g);
				if (m) {
					const n = Number(m[m.length - 1]!.replace(/frame=\s*/, ''));
					if (n > lastFrame) {
						lastFrame = n;
						job.progress = n;
					}
				}
			},
		},
	);

	if (code !== 0) throw new Error(`ffmpeg failed: ${stderr.slice(-500)}`);

	const files = (await readdir(outDir)).filter((f) => f.endsWith('.jpg')).sort();
	job.totalFrames = files.length;
	job.progress = files.length;
	job.status = 'done';
}

async function processJob(job: Job, videoPath: string, everyN: number, sourceLabel: string) {
	try {
		job.source = sourceLabel;
		const meta = await probeVideo(videoPath);
		job.width = meta.width;
		job.height = meta.height;
		job.fps = meta.fps;
		job.duration = meta.duration;

		const outDir = join(FRAMES, job.id);
		await mkdir(outDir, { recursive: true });
		await extractFrames(job, videoPath, outDir, everyN);
	} catch (e) {
		job.status = 'error';
		job.error = e instanceof Error ? e.message : String(e);
	}
}

function guessExt(url: string) {
	try {
		const path = url.startsWith('file:') ? new URL(url).pathname : url.includes('://') ? new URL(url).pathname : url;
		const e = extname(path).toLowerCase();
		if (['.mp4', '.webm', '.mov', '.mkv', '.avi', '.m4v'].includes(e)) return e;
	} catch {
		/* ignore */
	}
	return '.mp4';
}

function localPathFromInput(input: string): string | null {
	const raw = input.trim();
	if (!raw) return null;
	if (raw.startsWith('file://')) {
		try {
			return decodeURIComponent(new URL(raw).pathname);
		} catch {
			return null;
		}
	}
	if (raw.startsWith('/') || /^[A-Za-z]:[\\/]/.test(raw)) return resolve(raw);
	return null;
}

async function resolveVideoSource(input: string, jobId: string) {
	const local = localPathFromInput(input);
	if (local) {
		if (!existsSync(local)) throw new Error(`Local file not found: ${local}`);
		const dest = join(UPLOADS, `${jobId}${extname(local) || '.mp4'}`);
		await copyFile(local, dest);
		return { videoPath: dest, sourceLabel: basename(local) };
	}
	const dest = join(UPLOADS, `${jobId}${guessExt(input)}`);
	await downloadUrl(input, dest);
	return { videoPath: dest, sourceLabel: input };
}

function json(data: unknown, status = 200) {
	return Response.json(data, { status });
}

async function handleParse(req: Request) {
	const contentType = req.headers.get('content-type') || '';
	const jobId = randomUUID();
	const job: Job = {
		id: jobId,
		status: 'queued',
		progress: 0,
		totalFrames: 0,
		source: '',
		createdAt: Date.now(),
	};
	jobs.set(jobId, job);

	let everyN = 1;
	let videoPath = '';
	let sourceLabel = '';

	try {
		if (contentType.includes('multipart/form-data')) {
			const form = await req.formData();
			const file = form.get('file');
			const url = form.get('url');
			const every = form.get('every');
			if (every) everyN = Math.max(1, Number(every) || 1);

			if (file instanceof File && file.size > 0) {
				const ext = extname(file.name) || '.mp4';
				videoPath = join(UPLOADS, `${jobId}${ext}`);
				await writeFile(videoPath, Buffer.from(await file.arrayBuffer()));
				sourceLabel = file.name;
			} else if (typeof url === 'string' && url.trim()) {
				job.status = 'downloading';
				const resolved = await resolveVideoSource(url.trim(), jobId);
				videoPath = resolved.videoPath;
				sourceLabel = resolved.sourceLabel;
			} else {
				jobs.delete(jobId);
				return json({ error: 'Provide a video file or URL' }, 400);
			}
		} else {
			const body = (await req.json()) as { url?: string; every?: number };
			everyN = Math.max(1, Number(body.every) || 1);
			if (!body.url?.trim()) {
				jobs.delete(jobId);
				return json({ error: 'Provide a video file or URL' }, 400);
			}
			job.status = 'downloading';
			const resolved = await resolveVideoSource(body.url.trim(), jobId);
			videoPath = resolved.videoPath;
			sourceLabel = resolved.sourceLabel;
		}
	} catch (e) {
		job.status = 'error';
		job.error = e instanceof Error ? e.message : String(e);
		return json({ id: jobId, status: job.status, error: job.error });
	}

	void processJob(job, videoPath, everyN, sourceLabel);
	return json({ id: jobId, status: job.status });
}

const server = Bun.serve({
	port: PORT,
	idleTimeout: 255,
	development: isDev
		? {
				hmr: true,
				console: true,
			}
		: false,
	routes: {
		'/': homepage,
		'/api/parse': {
			POST: (req) => handleParse(req),
		},
		'/api/jobs/:id': {
			GET: (req) => {
				const job = jobs.get(req.params.id);
				if (!job) return json({ error: 'Job not found' }, 404);
				return json(job);
			},
			DELETE: async (req) => {
				const id = req.params.id;
				jobs.delete(id);
				await rm(join(FRAMES, id), { recursive: true, force: true });
				const uploads = await readdir(UPLOADS);
				for (const f of uploads) {
					if (f.startsWith(id)) await rm(join(UPLOADS, f), { force: true });
				}
				return json({ ok: true });
			},
		},
		'/api/jobs/:id/frames': {
			GET: async (req) => {
				const job = jobs.get(req.params.id);
				if (!job) return json({ error: 'Job not found' }, 404);
				if (job.status !== 'done') {
					return json({
						status: job.status,
						progress: job.progress,
						totalFrames: job.totalFrames,
						frames: [],
					});
				}
				const dir = join(FRAMES, job.id);
				const files = (await readdir(dir)).filter((f) => f.endsWith('.jpg')).sort();
				return json({
					status: job.status,
					totalFrames: files.length,
					frames: files.map((f, i) => ({
						index: i,
						name: f,
						url: `/frames/${job.id}/${f}`,
					})),
					meta: {
						source: job.source,
						width: job.width,
						height: job.height,
						fps: job.fps,
						duration: job.duration,
					},
				});
			},
		},
		'/api/jobs/:id/export': {
			GET: async (req) => {
				const job = jobs.get(req.params.id);
				if (!job) return json({ error: 'Job not found' }, 404);
				if (job.status !== 'done') return json({ error: 'Job not ready' }, 400);

				const dir = join(FRAMES, job.id);
				const files = (await readdir(dir)).filter((f) => f.endsWith('.jpg')).sort();
				if (!files.length) return json({ error: 'No frames' }, 404);

				const q = new URL(req.url).searchParams;
				let from = Math.trunc(Number(q.get('from') ?? 1));
				let to = Math.trunc(Number(q.get('to') ?? files.length));
				if (!Number.isFinite(from)) from = 1;
				if (!Number.isFinite(to)) to = files.length;
				from = Math.min(Math.max(1, from), files.length);
				to = Math.min(Math.max(1, to), files.length);
				if (from > to) [from, to] = [to, from];

				const slice = files.slice(from - 1, to);
				const zipName = `frames_${from}-${to}.zip`;
				const zipPath = join(TMP, `${job.id}_${from}-${to}_${Date.now()}.zip`);
				const list = slice.map((f) => f).join('\n') + '\n';

				const { code, stderr } = await run('zip', ['-q', '-j', zipPath, '-@'], {
					cwd: dir,
					stdin: list,
				});
				if (code !== 0 || !existsSync(zipPath)) {
					return json({ error: `zip failed: ${stderr.slice(-400) || 'unknown'}` }, 500);
				}

				const body = await Bun.file(zipPath).arrayBuffer();
				void rm(zipPath, { force: true });

				return new Response(body, {
					headers: {
						'Content-Type': 'application/zip',
						'Content-Disposition': `attachment; filename="${zipName}"`,
						'Content-Length': String(body.byteLength),
					},
				});
			},
		},
		'/frames/:jobId/:file': {
			GET: async (req) => {
				const { jobId, file } = req.params;
				if (file.includes('..') || jobId.includes('..')) {
					return new Response('Forbidden', { status: 403 });
				}
				const path = join(FRAMES, jobId, basename(file));
				if (!existsSync(path)) return new Response('Not found', { status: 404 });
				const s = await stat(path);
				return new Response(Bun.file(path), {
					headers: {
						'Content-Type': 'image/jpeg',
						'Content-Length': String(s.size),
						'Cache-Control': 'public, max-age=3600',
					},
				});
			},
		},
	},
});

console.log(`Frameforge on http://localhost:${server.port}`);
