/**
 * Card Component Tests
 * Tests for the actual Card component implementation
 */

import React from 'react';
import { render, screen } from '@testing-library/react';
import '@testing-library/jest-dom';
import { Card, CardHeader, CardTitle, CardContent } from '@/components/ui/card';

describe('Card Component', () => {
  describe('Card', () => {
    it('should render children', () => {
      render(<Card>Card content</Card>);
      expect(screen.getByText('Card content')).toBeInTheDocument();
    });

    it('should have rounded corners', () => {
      render(<Card data-testid="card">Content</Card>);
      expect(screen.getByTestId('card')).toHaveClass('rounded-[14px]');
    });

    it('should apply default variant styles', () => {
      render(<Card data-testid="card">Content</Card>);
      const card = screen.getByTestId('card');
      expect(card.className).toContain('bg-[var(--color-surface-elevated)]');
      expect(card.className).toContain('border');
    });

    it('should apply elevated variant', () => {
      render(<Card variant="elevated" data-testid="card">Content</Card>);
      const card = screen.getByTestId('card');
      expect(card.className).toContain('shadow-[var(--shadow-md)]');
    });

    it('should apply outlined variant', () => {
      render(<Card variant="outlined" data-testid="card">Content</Card>);
      const card = screen.getByTestId('card');
      expect(card.className).toContain('bg-transparent');
      expect(card.className).toContain('border');
    });

    it('should apply custom className', () => {
      render(<Card className="custom-card" data-testid="card">Content</Card>);
      expect(screen.getByTestId('card')).toHaveClass('custom-card');
    });

    it('should forward ref', () => {
      const ref = React.createRef<HTMLDivElement>();
      render(<Card ref={ref}>Content</Card>);
      expect(ref.current).toBeInstanceOf(HTMLDivElement);
    });
  });

  describe('Card Padding', () => {
    it('should apply medium padding by default', () => {
      render(<Card data-testid="card">Content</Card>);
      expect(screen.getByTestId('card')).toHaveClass('p-4');
    });

    it('should apply no padding when padding="none"', () => {
      render(<Card padding="none" data-testid="card">Content</Card>);
      expect(screen.getByTestId('card')).toHaveClass('p-0');
    });

    it('should apply small padding', () => {
      render(<Card padding="sm" data-testid="card">Content</Card>);
      expect(screen.getByTestId('card')).toHaveClass('p-3');
    });

    it('should apply large padding', () => {
      render(<Card padding="lg" data-testid="card">Content</Card>);
      expect(screen.getByTestId('card')).toHaveClass('p-6');
    });
  });

  describe('Interactive Card', () => {
    it('should apply interactive styles when interactive=true', () => {
      render(<Card interactive data-testid="card">Content</Card>);
      const card = screen.getByTestId('card');
      expect(card).toHaveClass('cursor-pointer');
      expect(card.className).toContain('hover:border-[var(--color-text-muted)]');
    });

    it('should not be interactive by default', () => {
      render(<Card data-testid="card">Content</Card>);
      expect(screen.getByTestId('card')).not.toHaveClass('cursor-pointer');
    });
  });

  describe('CardHeader', () => {
    it('should render children', () => {
      render(
        <Card>
          <CardHeader>Header content</CardHeader>
        </Card>
      );
      expect(screen.getByText('Header content')).toBeInTheDocument();
    });

    it('should have flex layout', () => {
      render(
        <Card>
          <CardHeader data-testid="header">Header</CardHeader>
        </Card>
      );
      expect(screen.getByTestId('header')).toHaveClass('flex');
      expect(screen.getByTestId('header')).toHaveClass('items-center');
      expect(screen.getByTestId('header')).toHaveClass('justify-between');
    });

    it('should have bottom margin', () => {
      render(
        <Card>
          <CardHeader data-testid="header">Header</CardHeader>
        </Card>
      );
      expect(screen.getByTestId('header')).toHaveClass('mb-3');
    });

    it('should apply custom className', () => {
      render(
        <Card>
          <CardHeader className="custom-header" data-testid="header">Header</CardHeader>
        </Card>
      );
      expect(screen.getByTestId('header')).toHaveClass('custom-header');
    });

    it('should forward ref', () => {
      const ref = React.createRef<HTMLDivElement>();
      render(
        <Card>
          <CardHeader ref={ref}>Header</CardHeader>
        </Card>
      );
      expect(ref.current).toBeInstanceOf(HTMLDivElement);
    });
  });

  describe('CardTitle', () => {
    it('should render title text', () => {
      render(
        <Card>
          <CardHeader>
            <CardTitle>My Title</CardTitle>
          </CardHeader>
        </Card>
      );
      expect(screen.getByText('My Title')).toBeInTheDocument();
    });

    it('should render as h3 element', () => {
      render(
        <Card>
          <CardHeader>
            <CardTitle>Title</CardTitle>
          </CardHeader>
        </Card>
      );
      expect(screen.getByRole('heading', { level: 3 })).toBeInTheDocument();
    });

    it('should have proper typography styles', () => {
      render(
        <Card>
          <CardHeader>
            <CardTitle data-testid="title">Title</CardTitle>
          </CardHeader>
        </Card>
      );
      const title = screen.getByTestId('title');
      expect(title).toHaveClass('text-base');
      expect(title).toHaveClass('font-semibold');
    });

    it('should apply custom className', () => {
      render(
        <Card>
          <CardHeader>
            <CardTitle className="custom-title" data-testid="title">Title</CardTitle>
          </CardHeader>
        </Card>
      );
      expect(screen.getByTestId('title')).toHaveClass('custom-title');
    });

    it('should forward ref', () => {
      const ref = React.createRef<HTMLHeadingElement>();
      render(
        <Card>
          <CardHeader>
            <CardTitle ref={ref}>Title</CardTitle>
          </CardHeader>
        </Card>
      );
      expect(ref.current).toBeInstanceOf(HTMLHeadingElement);
    });
  });

  describe('CardContent', () => {
    it('should render content', () => {
      render(
        <Card>
          <CardContent>Content here</CardContent>
        </Card>
      );
      expect(screen.getByText('Content here')).toBeInTheDocument();
    });

    it('should apply custom className', () => {
      render(
        <Card>
          <CardContent className="custom-content" data-testid="content">Content</CardContent>
        </Card>
      );
      expect(screen.getByTestId('content')).toHaveClass('custom-content');
    });

    it('should forward ref', () => {
      const ref = React.createRef<HTMLDivElement>();
      render(
        <Card>
          <CardContent ref={ref}>Content</CardContent>
        </Card>
      );
      expect(ref.current).toBeInstanceOf(HTMLDivElement);
    });
  });

  describe('Full Card Composition', () => {
    it('should render complete card with all parts', () => {
      render(
        <Card data-testid="card">
          <CardHeader>
            <CardTitle>Product Card</CardTitle>
          </CardHeader>
          <CardContent>
            <p>This is the product description.</p>
          </CardContent>
        </Card>
      );
      
      expect(screen.getByTestId('card')).toBeInTheDocument();
      expect(screen.getByText('Product Card')).toBeInTheDocument();
      expect(screen.getByText('This is the product description.')).toBeInTheDocument();
    });

    it('should allow nesting multiple content sections', () => {
      render(
        <Card>
          <CardContent>Section 1</CardContent>
          <CardContent>Section 2</CardContent>
        </Card>
      );
      
      expect(screen.getByText('Section 1')).toBeInTheDocument();
      expect(screen.getByText('Section 2')).toBeInTheDocument();
    });
  });

  describe('Accessibility', () => {
    it('should allow adding role to card', () => {
      render(<Card role="article" data-testid="card">Content</Card>);
      expect(screen.getByTestId('card')).toHaveAttribute('role', 'article');
    });

    it('should support aria-labelledby for card', () => {
      render(
        <Card aria-labelledby="card-title" data-testid="card">
          <CardHeader>
            <CardTitle id="card-title">Accessible Card</CardTitle>
          </CardHeader>
        </Card>
      );
      expect(screen.getByTestId('card')).toHaveAttribute('aria-labelledby', 'card-title');
    });
  });
});
