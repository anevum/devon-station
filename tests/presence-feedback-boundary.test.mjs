import test from 'node:test';
import assert from 'node:assert/strict';
import {emptyState,validateOwnerState} from '../worker/state.mjs';
import {validatePortableBackupState} from '../src/backup-core.mjs';

test('Presence Studio feedback remains valid in private owner-state and portable recovery',()=>{
 const state=emptyState();
 state.feedback.push({
  id:'local:12345678-1234-4123-8123-123456789012',
  section:'presence',
  category:'Design',
  note:'Improve content planner keyboard flow.',
  state:'Open',
  createdAt:'2026-11-02T20:00:00Z'
 });
 const privateState=validateOwnerState(state);
 assert.equal(privateState.feedback.length,1);
 assert.equal(privateState.feedback[0].section,'presence');
 const exported=validatePortableBackupState(privateState);
 assert.equal(exported.feedback[0].section,'presence');
 assert.equal(exported.feedback[0].note,'Improve content planner keyboard flow.');
 assert.throws(()=>validateOwnerState({...state,feedback:[{...state.feedback[0],section:'unapproved'}]}),/invalid_feedback/);
 assert.throws(()=>validatePortableBackupState({...state,feedback:[{...state.feedback[0],section:'unapproved'}]}),/invalid_backup_feedback/);
});
