<script setup>
// Renders a form from a type's JSON-schema-ish configSchema. Two-way binds a
// flat config object via v-model. Field widget is picked from property.type:
//   string  -> text input
//   integer -> number input
//   boolean -> toggle
//   array of string/integer -> repeatable single-value rows
//   array of object (e.g. github repos {owner,repo}) -> repeatable multi-field rows
// credentialKeys get a "this is a Bitwarden key name, not the secret" hint.
import { computed } from 'vue'

const props = defineProps({
  schema: { type: Object, required: true }, // { type:'object', required:[], properties:{} }
  modelValue: { type: Object, required: true },
  credentialKeys: { type: Array, default: () => [] }
})
const emit = defineEmits(['update:modelValue'])

const fields = computed(() => {
  const props_ = (props.schema && props.schema.properties) || {}
  const required = (props.schema && props.schema.required) || []
  return Object.entries(props_).map(([key, def]) => ({
    key,
    def,
    label: def.title || key,
    description: def.description || '',
    required: required.includes(key),
    isCredential: props.credentialKeys.includes(key),
    widget: widgetFor(def)
  }))
})

function widgetFor(def) {
  if (def.type === 'boolean') return 'boolean'
  if (def.type === 'integer' || def.type === 'number') return 'number'
  if (def.type === 'array') {
    const itemType = def.items && def.items.type
    return itemType === 'object' ? 'object-array' : 'scalar-array'
  }
  return 'string'
}

function objectFields(def) {
  const itemProps = (def.items && def.items.properties) || {}
  return Object.keys(itemProps)
}

function setValue(key, value) {
  emit('update:modelValue', { ...props.modelValue, [key]: value })
}

// ---- array helpers (operate on a copy, emit the new config) ----
function arr(key) {
  const v = props.modelValue[key]
  return Array.isArray(v) ? v : []
}

function addScalar(field) {
  const itemType = field.def.items && field.def.items.type
  setValue(field.key, [...arr(field.key), itemType === 'integer' || itemType === 'number' ? 0 : ''])
}
function updateScalar(key, idx, raw, itemType) {
  const next = arr(key).slice()
  next[idx] = itemType === 'integer' || itemType === 'number' ? toNum(raw) : raw
  setValue(key, next)
}
function removeScalar(key, idx) {
  const next = arr(key).slice()
  next.splice(idx, 1)
  setValue(key, next)
}

function addObject(field) {
  const blank = {}
  for (const f of objectFields(field.def)) blank[f] = ''
  setValue(field.key, [...arr(field.key), blank])
}
function updateObject(key, idx, subKey, raw) {
  const next = arr(key).slice()
  next[idx] = { ...next[idx], [subKey]: raw }
  setValue(key, next)
}
function removeObject(key, idx) {
  const next = arr(key).slice()
  next.splice(idx, 1)
  setValue(key, next)
}

function toNum(raw) {
  if (raw === '' || raw == null) return null
  const n = Number(raw)
  return Number.isNaN(n) ? raw : n
}
</script>

<template>
  <div class="flex flex-col gap-4">
    <div v-for="field in fields" :key="field.key">
      <label class="mb-1 flex items-center gap-2 text-sm font-medium text-slate-200">
        <span>{{ field.label }}</span>
        <span v-if="field.required" class="text-rose-400">*</span>
        <span
          v-if="field.isCredential"
          class="pill border border-amber-400/30 bg-amber-400/10 text-amber-300"
        >
          <AppIcon glyph="🔑" /> secret key
        </span>
      </label>

      <!-- string -->
      <input
        v-if="field.widget === 'string'"
        type="text"
        class="field-input"
        :value="modelValue[field.key] ?? ''"
        :placeholder="field.def.default != null ? String(field.def.default) : ''"
        @input="setValue(field.key, $event.target.value)"
      />

      <!-- number / integer -->
      <input
        v-else-if="field.widget === 'number'"
        type="number"
        class="field-input"
        :value="modelValue[field.key] ?? ''"
        :placeholder="field.def.default != null ? String(field.def.default) : ''"
        @input="setValue(field.key, toNum($event.target.value))"
      />

      <!-- boolean toggle -->
      <button
        v-else-if="field.widget === 'boolean'"
        type="button"
        role="switch"
        :aria-checked="!!modelValue[field.key]"
        class="relative inline-flex h-6 w-11 shrink-0 items-center rounded-full transition-colors"
        :class="modelValue[field.key] ? 'bg-brand-gradient' : 'bg-white/10'"
        @click="setValue(field.key, !modelValue[field.key])"
      >
        <span
          class="inline-block h-4 w-4 transform rounded-full bg-white transition-transform"
          :class="modelValue[field.key] ? 'translate-x-6' : 'translate-x-1'"
        ></span>
      </button>

      <!-- scalar array (strings / integers) -->
      <div v-else-if="field.widget === 'scalar-array'" class="flex flex-col gap-2">
        <div
          v-for="(item, idx) in arr(field.key)"
          :key="idx"
          class="flex items-center gap-2"
        >
          <input
            :type="field.def.items && (field.def.items.type === 'integer' || field.def.items.type === 'number') ? 'number' : 'text'"
            class="field-input"
            :value="item"
            @input="updateScalar(field.key, idx, $event.target.value, field.def.items && field.def.items.type)"
          />
          <button type="button" class="row-remove" @click="removeScalar(field.key, idx)"><AppIcon glyph="✕" /></button>
        </div>
        <button type="button" class="row-add" @click="addScalar(field)">+ Add</button>
      </div>

      <!-- object array (e.g. github repos: {owner, repo}) -->
      <div v-else-if="field.widget === 'object-array'" class="flex flex-col gap-2">
        <div
          v-for="(item, idx) in arr(field.key)"
          :key="idx"
          class="flex items-center gap-2"
        >
          <div class="grid flex-1 gap-2" :style="{ gridTemplateColumns: `repeat(${objectFields(field.def).length}, minmax(0, 1fr))` }">
            <input
              v-for="subKey in objectFields(field.def)"
              :key="subKey"
              type="text"
              class="field-input"
              :placeholder="subKey"
              :value="item[subKey] ?? ''"
              @input="updateObject(field.key, idx, subKey, $event.target.value)"
            />
          </div>
          <button type="button" class="row-remove" @click="removeObject(field.key, idx)"><AppIcon glyph="✕" /></button>
        </div>
        <button type="button" class="row-add" @click="addObject(field)">+ Add row</button>
      </div>

      <p v-if="field.isCredential" class="mt-1 text-xs text-amber-300/70">
        Secret <em>key name</em> (not the secret itself) — e.g. <code>{{ field.def.default || 'my_github_pat' }}</code>.
      </p>
      <p v-else-if="field.description" class="mt-1 text-xs text-slate-500">
        {{ field.description }}
      </p>
    </div>
  </div>
</template>

<style scoped>
.field-input {
  @apply w-full rounded-xl border border-white/10 bg-white/[0.04] px-3 py-2 text-sm text-slate-100 outline-none transition-colors;
  @apply placeholder:text-slate-600 focus:border-brand-violet/60 focus:bg-white/[0.06];
}
.row-add {
  @apply self-start rounded-lg border border-brand-violet/30 bg-brand-violet/10 px-3 py-1.5 text-xs font-medium text-violet-300 transition-colors hover:bg-brand-violet/20;
}
.row-remove {
  @apply shrink-0 rounded-lg border border-rose-500/20 bg-rose-500/5 px-2.5 py-2 text-xs text-rose-400/80 transition-colors hover:bg-rose-500/15;
}
</style>
