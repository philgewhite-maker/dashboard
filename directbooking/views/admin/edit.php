<?php /** @var string $table @var string $id @var string $json @var ?string $error @var bool $isNew */ $h = 'Util::h'; ?>
<p><a href="/admin/table?table=<?= $h($table) ?>">Back to <?= $h(str_replace('_', ' ', $table)) ?></a></p>
<?php if ($error): ?><p class="errors"><?= $h($error) ?></p><?php endif; ?>
<form method="post" class="stack">{{csrf}}
  <textarea name="json" rows="28" spellcheck="false" class="code"><?= $h($json) ?></textarea>
  <button><?= $isNew ? 'Create' : 'Save' ?></button>
</form>
<p class="small muted">Text in <code>data</code> can be a plain string or <code>{"en": "...", "ko": "..."}</code>. A child record inherits any <code>data</code> key it doesn't set from its parent (city → area → building → property → listing; venue → event → occurrence). <code>arrival_info</code> is private: it only goes in the confirmation email.</p>
