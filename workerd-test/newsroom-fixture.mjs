/**
 * Synthetic Miniflare-only entrypoint: not imported by the RB01 application.
 * It exposes no unauthenticated initialization or configuration endpoints.
 */
import {createNewsroomHandler} from '../worker/newsroom.mjs';
export default createNewsroomHandler();
