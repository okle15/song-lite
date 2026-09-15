/**
 * Music library data source — Phase 7.
 *
 * Decision H2: when `MUSIC_DIR` env is set and the directory contains
 * audio files, `getSongs()` scans it with `music-metadata` (H1) and returns
 * the parsed `Song[]`. When `MUSIC_DIR` is unset or the scan returns
 * nothing, it falls back to the `MOCK_SONGS` array so the app always has
 * a working library.
 *
 * Song shape matches decision G1: id / title / artist / album / year /
 * genre / mood / durationSec / filePath.
 */
import { scanLibrary } from './scanner';

export type Song = {
	id: string;
	title: string;
	artist: string;
	album: string;
	year: number;
	genre: string;
	mood: string;
	durationSec: number;
	filePath: string;
	/** 配对到的 MV 视频文件路径（mp4 等），播放器可提供「看 MV」入口；无则缺省 */
	mvPath?: string;
};

/** Mock fallback (10 songs) used when MUSIC_DIR is not configured. */
export const MOCK_SONGS: Song[] = [
	{ id: 'song-001', title: 'Take Five', artist: 'Dave Brubeck Quartet', album: 'Time Out', year: 1959, genre: 'jazz', mood: 'relaxed', durationSec: 324, filePath: '/music/jazz/take-five.mp3' },
	{ id: 'song-002', title: 'So What', artist: 'Miles Davis', album: 'Kind of Blue', year: 1959, genre: 'jazz', mood: 'cool', durationSec: 565, filePath: '/music/jazz/so-what.mp3' },
	{ id: 'song-003', title: 'Blue in Green', artist: 'Miles Davis', album: 'Kind of Blue', year: 1959, genre: 'jazz', mood: 'melancholic', durationSec: 337, filePath: '/music/jazz/blue-in-green.mp3' },
	{ id: 'song-004', title: 'Bohemian Rhapsody', artist: 'Queen', album: 'A Night at the Opera', year: 1975, genre: 'rock', mood: 'epic', durationSec: 354, filePath: '/music/rock/bohemian-rhapsody.mp3' },
	{ id: 'song-005', title: 'Hotel California', artist: 'Eagles', album: 'Hotel California', year: 1977, genre: 'rock', mood: 'mysterious', durationSec: 391, filePath: '/music/rock/hotel-california.mp3' },
	{ id: 'song-006', title: 'Clair de Lune', artist: 'Claude Debussy', album: 'Suite bergamasque', year: 1905, genre: 'classical', mood: 'peaceful', durationSec: 312, filePath: '/music/classical/clair-de-lune.mp3' },
	{ id: 'song-007', title: 'Für Elise', artist: 'Ludwig van Beethoven', album: 'Bagatelles', year: 1810, genre: 'classical', mood: 'gentle', durationSec: 180, filePath: '/music/classical/fur-elise.mp3' },
	{ id: 'song-008', title: 'Blinding Lights', artist: 'The Weeknd', album: 'After Hours', year: 2020, genre: 'pop', mood: 'energetic', durationSec: 200, filePath: '/music/pop/blinding-lights.mp3' },
	{ id: 'song-009', title: 'Shape of You', artist: 'Ed Sheeran', album: '÷ (Divide)', year: 2017, genre: 'pop', mood: 'upbeat', durationSec: 233, filePath: '/music/pop/shape-of-you.mp3' },
	{ id: 'song-010', title: 'Weightless', artist: 'Marconi Union', album: 'Weightless', year: 2011, genre: 'ambient', mood: 'calm', durationSec: 480, filePath: '/music/ambient/weightless.mp3' },
];

/**
 * Get the current library: scanned from `MUSIC_DIR` if configured and
 * non-empty, otherwise the mock fallback. Async because scanning involves
 * file I/O + metadata parsing. Results are cached by the scanner.
 */
export async function getSongs(): Promise<Song[]> {
	const scanned = await scanLibrary();
	return scanned.length > 0 ? scanned : MOCK_SONGS;
}

/** Find a song by id (async — scans the library if configured). */
export async function findSongById(id: string): Promise<Song | undefined> {
	const songs = await getSongs();
	return songs.find((song) => song.id === id);
}
