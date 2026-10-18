/**
 * Button Component Tests
 * Tests for the actual Button component implementation
 */

import React from 'react';
import { render, screen, fireEvent } from '@testing-library/react';
import '@testing-library/jest-dom';
import { Button } from '@/components/ui/button';

describe('Button Component', () => {
  describe('Rendering', () => {
    it('should render with children text', () => {
      render(<Button>Click me</Button>);
      expect(screen.getByRole('button')).toHaveTextContent('Click me');
    });

    it('should render as a button element', () => {
      render(<Button>Test</Button>);
      expect(screen.getByRole('button')).toBeInTheDocument();
    });

    it('should apply base styles', () => {
      render(<Button>Test</Button>);
      const button = screen.getByRole('button');
      expect(button).toHaveClass('inline-flex');
      expect(button).toHaveClass('items-center');
      expect(button).toHaveClass('justify-center');
    });
  });

  describe('Variants', () => {
    it('should render primary variant by default', () => {
      render(<Button>Primary</Button>);
      const button = screen.getByRole('button');
      expect(button.className).toContain('bg-[var(--color-primary)]');
    });

    it('should render secondary variant', () => {
      render(<Button variant="secondary">Secondary</Button>);
      const button = screen.getByRole('button');
      expect(button.className).toContain('bg-transparent');
      expect(button.className).toContain('border');
    });

    it('should render ghost variant', () => {
      render(<Button variant="ghost">Ghost</Button>);
      const button = screen.getByRole('button');
      expect(button.className).toContain('bg-transparent');
    });

    it('should render danger variant', () => {
      render(<Button variant="danger">Danger</Button>);
      const button = screen.getByRole('button');
      expect(button.className).toContain('bg-[var(--color-danger)]');
    });
  });

  describe('Sizes', () => {
    it('should render medium size by default', () => {
      render(<Button>Medium</Button>);
      const button = screen.getByRole('button');
      expect(button).toHaveClass('h-11');
      expect(button).toHaveClass('px-4');
    });

    it('should render small size', () => {
      render(<Button size="sm">Small</Button>);
      const button = screen.getByRole('button');
      expect(button).toHaveClass('h-9');
      expect(button).toHaveClass('px-3');
    });

    it('should render large size', () => {
      render(<Button size="lg">Large</Button>);
      const button = screen.getByRole('button');
      expect(button).toHaveClass('h-12');
      expect(button).toHaveClass('px-6');
    });
  });

  describe('Interactions', () => {
    it('should call onClick when clicked', () => {
      const handleClick = jest.fn();
      render(<Button onClick={handleClick}>Click</Button>);
      
      fireEvent.click(screen.getByRole('button'));
      expect(handleClick).toHaveBeenCalledTimes(1);
    });

    it('should not call onClick when disabled', () => {
      const handleClick = jest.fn();
      render(<Button onClick={handleClick} disabled>Disabled</Button>);
      
      fireEvent.click(screen.getByRole('button'));
      expect(handleClick).not.toHaveBeenCalled();
    });

    it('should have disabled attribute when disabled', () => {
      render(<Button disabled>Disabled</Button>);
      expect(screen.getByRole('button')).toBeDisabled();
    });
  });

  describe('Loading State', () => {
    it('should show loading spinner when loading', () => {
      render(<Button loading>Loading</Button>);
      // The Loader2 icon should be present
      const button = screen.getByRole('button');
      expect(button.querySelector('svg')).toBeInTheDocument();
    });

    it('should be disabled when loading', () => {
      render(<Button loading>Loading</Button>);
      expect(screen.getByRole('button')).toBeDisabled();
    });

    it('should still show children text when loading', () => {
      render(<Button loading>Submit</Button>);
      expect(screen.getByRole('button')).toHaveTextContent('Submit');
    });
  });

  describe('Full Width', () => {
    it('should apply full width class when fullWidth is true', () => {
      render(<Button fullWidth>Full Width</Button>);
      expect(screen.getByRole('button')).toHaveClass('w-full');
    });

    it('should not have full width class by default', () => {
      render(<Button>Normal</Button>);
      expect(screen.getByRole('button')).not.toHaveClass('w-full');
    });
  });

  describe('Custom className', () => {
    it('should apply custom className', () => {
      render(<Button className="custom-class">Custom</Button>);
      expect(screen.getByRole('button')).toHaveClass('custom-class');
    });

    it('should merge custom className with default styles', () => {
      render(<Button className="my-custom">Merged</Button>);
      const button = screen.getByRole('button');
      expect(button).toHaveClass('my-custom');
      expect(button).toHaveClass('inline-flex');
    });
  });

  describe('Ref Forwarding', () => {
    it('should forward ref to button element', () => {
      const ref = React.createRef<HTMLButtonElement>();
      render(<Button ref={ref}>Ref Test</Button>);
      expect(ref.current).toBeInstanceOf(HTMLButtonElement);
    });
  });

  describe('HTML Attributes', () => {
    it('should pass through type attribute', () => {
      render(<Button type="submit">Submit</Button>);
      expect(screen.getByRole('button')).toHaveAttribute('type', 'submit');
    });

    it('should pass through aria-label', () => {
      render(<Button aria-label="Close dialog">X</Button>);
      expect(screen.getByRole('button')).toHaveAttribute('aria-label', 'Close dialog');
    });

    it('should pass through data attributes', () => {
      render(<Button data-testid="my-button">Test</Button>);
      expect(screen.getByTestId('my-button')).toBeInTheDocument();
    });
  });
});
