<script setup>
// The Observer in a floating window — same chrome as a session chat, but it's the conversational
// proprioception surface (talk to the assistant as a whole). Opened via the button on the Self view.
import { ref, onMounted } from 'vue'
import FloatingWindow from './FloatingWindow.vue'
import ObserverChat from './ObserverChat.vue'
import { identity } from '@/services/api'

defineProps({ z: { type: Number, default: 70 }, focused: { type: Boolean, default: true }, minimized: { type: Boolean, default: false } })
defineEmits(['close', 'minimize', 'focus'])

const name = ref('the assistant')
onMounted(() => { identity.get().then((d) => { if (d && d.name) name.value = d.name }).catch(() => {}) })
</script>

<template>
  <FloatingWindow storage-key="asmltr:win:observer" subtitle="proprioception · grounded in the live body"
                  :z="z" :focused="focused" :minimized="minimized"
                  @close="$emit('close')" @minimize="$emit('minimize')" @focus="$emit('focus')">
    <template #title>
      <h2 class="truncate text-base font-bold tracking-tight">
        <span class="gradient-text">🧠 The Observer</span>
        <span class="text-sm font-normal text-slate-400"> — {{ name }} as a whole</span>
      </h2>
    </template>
    <ObserverChat />
  </FloatingWindow>
</template>
