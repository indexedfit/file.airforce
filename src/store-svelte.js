import { writable } from 'svelte/store';

export const helia = writable(null);
export const fs = writable(null);
export const roomManager = writable(null);
export const peers = writable([]);
export const peerId = writable('');
