export interface CategoryDto {
  id: string;
  name: string;
}

export interface CategoryListRequestDto {
  userId: string | number;
}

export interface CategoryCreateRequestDto {
  userId: string | number;
  name: string;
}

export interface CategoryArchiveRequestDto {
  userId: string | number;
  categoryId: string;
}

export interface CategoryListResponseDto {
  status: 'ok';
  categories: CategoryDto[];
}
