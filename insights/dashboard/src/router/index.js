import { createRouter, createWebHistory } from 'vue-router'

const routes = [
  { path: '/', name: 'live', component: () => import('@/views/Live.vue'), meta: { title: 'Live', icon: '◉' } },
  { path: '/timeline', name: 'timeline', component: () => import('@/views/Timeline.vue'), meta: { title: 'Timeline', icon: '≣' } },
  { path: '/usage', name: 'usage', component: () => import('@/views/Usage.vue'), meta: { title: 'Usage', icon: '▤' } },
  { path: '/system', name: 'system', component: () => import('@/views/System.vue'), meta: { title: 'System', icon: '▦' } },
  { path: '/voice', name: 'voice', component: () => import('@/views/Voice.vue'), meta: { title: 'Voice', icon: '🎙' } },
  { path: '/notifications', name: 'notifications', component: () => import('@/views/Notifications.vue'), meta: { title: 'Notifications', icon: '✦' } },
  { path: '/drafts', name: 'drafts', component: () => import('@/views/Drafts.vue'), meta: { title: 'Drafts', icon: '✎' } },
  { path: '/integrations', name: 'integrations', component: () => import('@/views/Integrations.vue'), meta: { title: 'Integrations', icon: '🔌' } },
  { path: '/access', name: 'access', component: () => import('@/views/Access.vue'), meta: { title: 'Access', icon: '🔑' } },
  { path: '/settings', name: 'settings', component: () => import('@/views/Settings.vue'), meta: { title: 'Settings', icon: '⚙' } }
]

export default createRouter({
  history: createWebHistory(),
  routes,
  scrollBehavior: () => ({ top: 0 })
})

export const NAV_ROUTES = routes
