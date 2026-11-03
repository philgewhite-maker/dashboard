<?php /** @var bool $sent */ ?>
<?php if ($sent): ?>
<p>If that address is registered, a sign-in link is on its way. It works once, for 15 minutes.</p>
<?php endif; ?>
<form method="post" action="/admin/login" class="stack">
  <label>Email<input type="email" name="email" autocomplete="email" required></label>
  <button>Email me a sign-in link</button>
</form>
