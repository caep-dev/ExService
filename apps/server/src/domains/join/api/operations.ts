import {
  submitJoinApplication,
  downloadJoinApplicationAttachment,
  listJoinApplications,
  getJoinApplication,
  approveJoinApplication,
  rejectJoinApplication,
} from './handlers.js'
export const operations = {
  submitJoinApplication,
  downloadJoinApplicationAttachment,
  listJoinApplications,
  getJoinApplication,
  approveJoinApplication,
  rejectJoinApplication,
} as const
