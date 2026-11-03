<?php
declare(strict_types=1);

final class View
{
    public static function render(string $template, array $vars = []): string
    {
        $file = dirname(__DIR__) . "/views/$template.php";
        if (!is_file($file)) throw new RuntimeException("Missing view $template");
        extract($vars, EXTR_SKIP);
        ob_start();
        try {
            include $file;
        } catch (Throwable $e) {
            ob_end_clean();
            throw $e;
        }
        return (string)ob_get_clean();
    }

    /** A page inside the public layout. */
    public static function page(string $template, array $vars): string
    {
        $vars['body'] = self::render($template, $vars);
        return self::render('layout', $vars);
    }
}
